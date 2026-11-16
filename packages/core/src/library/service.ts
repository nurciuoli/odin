// LibraryService: plain files under <ODIN_HOME>/library (one directory per kind), versions in library_versions,
// installs into projects (copy or merge) in installations, drift recomputed from disk. docs/contracts.md#library.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AssetDetail, AssetFiles, AssetKind, AssetVersion, DriftState, Installation, InstallRequest, InstallResult, LibraryAsset,
  SettingsProfileSpec,
} from "@odin/shared/api";
import { ASSET_ID_PATTERN, ASSET_KINDS, INSTALL_TARGETS, LIBRARY_LAYOUT } from "@odin/shared/library";
import { filesHash } from "../hash.ts";
import { HttpError } from "../http/util.ts";
import type { Deps, LibraryService, Services } from "../services.ts";
import { isDirectory, isHidden, readRegularFile, readTree, removePath, replaceDirAtomic, resolveInside as resolveRaw, writeFileAtomic } from "./files.ts";
import {
  addSettings, deepEqual, formatJson, fragmentSize, mcpEntry, parseJsonObject, presentSettings, removeMcpEntry, removeSettings,
  type SettingsFragment, setMcpEntry,
} from "./merge.ts";
import { instructionFragment, setInstruction } from "./instructions.ts";
import { migrateLegacyLibrary } from "./migrate.ts";
import { MAX_ASSET_FILE_BYTES, entryFile, filesError, parseAsset } from "./parse.ts";

interface Entry {
  asset: LibraryAsset;
  files: AssetFiles;
}

interface InstallRow {
  project: string;
  kind: AssetKind;
  asset_id: string;
  installed_version: string;
  paths: string;
  merged: string | null;
  installed_at: string;
}

/** What a project holds for an installed asset now, in library form (for hashing, diffs and push). */
interface ProjectState {
  files: AssetFiles | null;
  /** Repo-relative paths that make it up. */
  paths: string[];
  /** Merge kinds: whether Odin's fragment is exactly as installed. */
  unchanged?: boolean;
}

const key = (kind: AssetKind, id: string) => `${kind}/${id}`;

/** resolveInside with a 409 (the project's or library's layout leads outside its root). */
function resolveInside(root: string, rel: string): string {
  try {
    return resolveRaw(root, rel);
  } catch (err) {
    throw new HttpError(409, (err as Error).message);
  }
}
const isKind = (k: unknown): k is AssetKind => typeof k === "string" && (ASSET_KINDS as string[]).includes(k);

function checkKindId(kind: unknown, id: unknown): asserts kind is AssetKind {
  if (!isKind(kind)) throw new HttpError(400, `unknown asset kind ${JSON.stringify(kind)}`);
  if (typeof id !== "string" || !ASSET_ID_PATTERN.test(id)) throw new HttpError(400, `invalid asset id ${JSON.stringify(id)}`);
}

export function createLibraryService(deps: Deps, services: Services): LibraryService {
  const { db, bus, config } = deps;
  const root = config.libraryDir;
  const nowIso = () => deps.now().toISOString();
  let cache = new Map<string, Entry>();

  // ── versions ──────────────────────────────────────────────────────────────

  const insertVersion = db.prepare("INSERT OR IGNORE INTO library_versions (kind, asset_id, version, files, first_seen_at) VALUES (?, ?, ?, ?, ?)");
  const firstSeen = db.prepare("SELECT first_seen_at FROM library_versions WHERE kind = ? AND asset_id = ? AND version = ?");

  /** Records a version when first seen; returns when that was. */
  function recordVersion(kind: AssetKind, id: string, version: string, files: AssetFiles): string {
    insertVersion.run(kind, id, version, JSON.stringify(files), nowIso());
    return (firstSeen.get(kind, id, version) as { first_seen_at: string }).first_seen_at;
  }

  function versionFiles(kind: AssetKind, id: string, version: string): AssetFiles | null {
    const row = db.prepare("SELECT files FROM library_versions WHERE kind = ? AND asset_id = ? AND version = ?").get(kind, id, version) as { files: string } | undefined;
    return row ? (JSON.parse(row.files) as AssetFiles) : null;
  }

  // ── reading the library ───────────────────────────────────────────────────

  function build(kind: AssetKind, id: string, files: AssetFiles, readError: string | null): Entry {
    const parsed = parseAsset(kind, id, files);
    const version = filesHash(files);
    const updatedAt = recordVersion(kind, id, version, files);
    const error = [readError, parsed.error].filter(Boolean).join("; ") || null;
    return {
      asset: { kind, id, name: parsed.name, description: parsed.description, version, updatedAt, files: Object.keys(files).sort(), meta: parsed.meta, error },
      files,
    };
  }

  function scanKind(kind: AssetKind, into: Map<string, Entry>): void {
    const layout = LIBRARY_LAYOUT[kind];
    const dir = join(root, layout.dir);
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (isHidden(name)) continue;
      const path = join(dir, name);
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st || st.isSymbolicLink()) continue;
      if (layout.shape === "file") {
        if (!st.isFile() || !name.endsWith(layout.entry)) continue;
        const id = name.slice(0, -layout.entry.length);
        if (!ASSET_ID_PATTERN.test(id)) continue;
        if (st.size > MAX_ASSET_FILE_BYTES) {
          into.set(key(kind, id), build(kind, id, {}, `${name} is larger than 1 MB`));
          continue;
        }
        let content: string | null = null;
        try {
          content = readRegularFile(path);
        } catch {
          // vanished or unreadable: skip it this round
        }
        if (content !== null) into.set(key(kind, id), build(kind, id, { [name]: content }, null));
      } else {
        if (!st.isDirectory() || !ASSET_ID_PATTERN.test(name)) continue;
        const tree = readTree(path);
        into.set(key(kind, name), build(kind, name, tree.files, tree.error));
      }
    }
  }

  function scanAll(): Map<string, Entry> {
    const next = new Map<string, Entry>();
    for (const kind of ASSET_KINDS) scanKind(kind, next);
    return next;
  }

  function rescan(): void {
    const next = scanAll();
    const old = cache;
    cache = next;
    for (const [k, e] of next) {
      const prev = old.get(k);
      if (!prev || prev.asset.version !== e.asset.version) bus.emit({ type: "library.updated", kind: e.asset.kind, id: e.asset.id });
    }
    for (const [k, e] of old) if (!next.has(k)) bus.emit({ type: "library.updated", kind: e.asset.kind, id: e.asset.id });
  }

  // First boot: an absent library is created from the seed directory.
  if (!existsSync(root)) {
    if (config.librarySeedDir && isDirectory(config.librarySeedDir)) cpSync(config.librarySeedDir, root, { recursive: true });
    else mkdirSync(root, { recursive: true });
  }
  migrateLegacyLibrary(root, db);
  cache = scanAll();
  const timer = config.projectsRescanMs > 0 ? setInterval(() => {
    try {
      rescan();
    } catch (err) {
      console.error("library rescan failed:", (err as Error).message);
    }
  }, config.projectsRescanMs) : null;
  timer?.unref();

  // ── writing the library ───────────────────────────────────────────────────

  function assetPath(kind: AssetKind, id: string): string {
    const layout = LIBRARY_LAYOUT[kind];
    return join(root, layout.dir, layout.shape === "file" ? `${id}${layout.entry}` : id);
  }

  function save(kind: AssetKind, id: string, files: AssetFiles): LibraryAsset {
    checkKindId(kind, id);
    const bad = filesError(kind, id, files);
    if (bad) throw new HttpError(400, bad);
    const parsed = parseAsset(kind, id, files);
    if (parsed.error) throw new HttpError(400, parsed.error);
    const target = assetPath(kind, id);
    resolveInside(root, join(LIBRARY_LAYOUT[kind].dir, LIBRARY_LAYOUT[kind].shape === "file" ? entryFile(kind, id) : id));
    if (LIBRARY_LAYOUT[kind].shape === "file") writeFileAtomic(target, files[entryFile(kind, id)]!);
    else replaceDirAtomic(target, files);
    const prev = cache.get(key(kind, id));
    // Re-read what landed so the cache matches a later rescan exactly.
    const tree = LIBRARY_LAYOUT[kind].shape === "file" ? { files: { [entryFile(kind, id)]: files[entryFile(kind, id)]! }, error: null } : readTree(target);
    const entry = build(kind, id, tree.files, tree.error);
    cache.set(key(kind, id), entry);
    if (!prev || prev.asset.version !== entry.asset.version) bus.emit({ type: "library.updated", kind, id });
    return entry.asset;
  }

  function remove(kind: AssetKind, id: string): void {
    checkKindId(kind, id);
    if (!cache.has(key(kind, id))) throw new HttpError(404, `no ${kind} "${id}" in the library`);
    removePath(assetPath(kind, id));
    cache.delete(key(kind, id));
    bus.emit({ type: "library.updated", kind, id });
  }

  // ── projects ──────────────────────────────────────────────────────────────

  function projectRoot(name: string): string {
    const ref = services.projects.get(name);
    if (!ref) throw new HttpError(404, `unknown project "${name}"`);
    if (ref.missing) throw new HttpError(409, `project "${name}" is missing on disk`);
    return ref.path;
  }

  /** Repo-relative location of a copy install: the file, or the skill's directory. */
  function copyTarget(kind: AssetKind, id: string): string {
    const t = INSTALL_TARGETS[kind]!;
    return LIBRARY_LAYOUT[kind].shape === "file" ? `${t.target}/${entryFile(kind, id)}` : `${t.target}/${id}`;
  }

  function readJsonTarget(projectPath: string, rel: string): Record<string, unknown> | null {
    const abs = resolveInside(projectPath, rel);
    try {
      return parseJsonObject(readRegularFile(abs), rel);
    } catch (err) {
      throw new HttpError(409, (err as Error).message);
    }
  }

  /** Name and description for a merge asset rebuilt from the project: the installed version's, else the library's. */
  function labels(kind: AssetKind, id: string, version: string | null): { name: string; description: string } {
    const files = (version && versionFiles(kind, id, version)) || cache.get(key(kind, id))?.files || null;
    if (!files) return { name: id, description: "" };
    const p = parseAsset(kind, id, files);
    return { name: p.name, description: p.description };
  }

  /** The installed version's spec (merge kinds), from library_versions. */
  function installedSpec(row: InstallRow): Record<string, unknown> | null {
    const files = versionFiles(row.kind, row.asset_id, row.installed_version);
    if (!files) return null;
    return parseAsset(row.kind, row.asset_id, files).meta;
  }

  function projectState(projectPath: string, kind: AssetKind, id: string, row: InstallRow | null): ProjectState {
    const target = INSTALL_TARGETS[kind];
    if (!target) throw new HttpError(400, `a ${kind} isn't installed into projects`);
    if (target.mode === "copy") {
      const rel = copyTarget(kind, id);
      const abs = resolveInside(projectPath, rel);
      if (LIBRARY_LAYOUT[kind].shape === "file") {
        let content: string | null;
        try {
          content = readRegularFile(abs);
        } catch {
          content = null;
        }
        return { files: content === null ? null : { [entryFile(kind, id)]: content }, paths: [rel] };
      }
      if (!isDirectory(abs)) return { files: null, paths: [] };
      const tree = readTree(abs);
      const keys = Object.keys(tree.files).sort();
      return { files: keys.length ? tree.files : null, paths: keys.map((k) => `${rel}/${k}`) };
    }
    if (kind === "instruction") {
      const text = readRegularFile(resolveInside(projectPath, target.target)) ?? "";
      const fragment = wrap(() => instructionFragment(text, id));
      return { files: fragment ? { "AGENTS.md": fragment.body } : null, paths: [target.target] };
    }
    const doc = readJsonTarget(projectPath, target.target);
    const file = `${id}.json`;
    const { name, description } = labels(kind, id, row?.installed_version ?? null);
    if (kind === "mcp") {
      let entry: unknown;
      try {
        entry = mcpEntry(doc, id);
      } catch (err) {
        throw new HttpError(409, (err as Error).message);
      }
      if (entry === null || entry === undefined) return { files: null, paths: [target.target], unchanged: false };
      const merged = row?.merged ? JSON.parse(row.merged) : null;
      const body = typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : { value: entry };
      return { files: { [file]: formatJson({ name, description, ...body }) }, paths: [target.target], unchanged: merged !== null && deepEqual(entry, merged) };
    }
    // settings: the entries of the installed profile that are still there.
    const spec = ((row && installedSpec(row)) ?? (row?.merged ? JSON.parse(row.merged) : null) ?? (cache.get(key(kind, id))?.asset.meta ?? {})) as SettingsProfileSpec;
    const present = presentSettings(doc, spec);
    const total = fragmentSize(spec);
    const have = fragmentSize(present);
    if (!doc || (total > 0 && have === 0)) return { files: null, paths: [target.target], unchanged: false };
    return { files: { [file]: formatJson({ name, description, ...present, ...(spec.codex ? { codex: spec.codex } : {}), ...(spec.opencode ? { opencode: spec.opencode } : {}) }) }, paths: [target.target], unchanged: have === total };
  }

  function toInstallation(row: InstallRow): Installation {
    const lib = cache.get(key(row.kind, row.asset_id));
    const libraryVersion = lib?.asset.version ?? null;
    const ref = services.projects.get(row.project);
    let state: ProjectState = { files: null, paths: JSON.parse(row.paths) as string[] };
    if (ref && !ref.missing) {
      try {
        state = projectState(ref.path, row.kind, row.asset_id, row);
      } catch {
        // unreadable (bad JSON, escaping path): reported as missing below
        state = { files: null, paths: JSON.parse(row.paths) as string[] };
      }
    }
    const projectVersion = state.files ? filesHash(state.files) : null;
    const libMoved = libraryVersion !== null && libraryVersion !== row.installed_version;
    let drift: DriftState;
    if (!state.files) drift = "missing";
    else {
      const unchanged = state.unchanged ?? projectVersion === row.installed_version;
      if (unchanged) drift = libMoved ? "update-available" : "current";
      else if (state.unchanged === undefined && projectVersion === libraryVersion) drift = "current";
      else drift = libMoved ? "conflict" : "modified";
    }
    return {
      project: row.project, kind: row.kind, id: row.asset_id, installedVersion: row.installed_version, libraryVersion, projectVersion,
      state: drift, paths: JSON.parse(row.paths) as string[], installedAt: row.installed_at,
    };
  }

  const getRow = (project: string, kind: AssetKind, id: string) =>
    (db.prepare("SELECT * FROM installations WHERE project = ? AND kind = ? AND asset_id = ?").get(project, kind, id) as InstallRow | undefined) ?? null;

  function upsertRow(project: string, kind: AssetKind, id: string, version: string, paths: string[], merged: unknown): InstallRow {
    db.prepare(
      `INSERT INTO installations (project, kind, asset_id, installed_version, paths, merged, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, kind, asset_id) DO UPDATE SET installed_version = excluded.installed_version, paths = excluded.paths,
       merged = excluded.merged, installed_at = excluded.installed_at`,
    ).run(project, kind, id, version, JSON.stringify(paths), merged === undefined || merged === null ? null : JSON.stringify(merged), nowIso());
    return getRow(project, kind, id)!;
  }

  function requireAsset(kind: AssetKind, id: string): Entry {
    const e = cache.get(key(kind, id));
    if (!e) throw new HttpError(404, `no ${kind} "${id}" in the library`);
    if (e.asset.error) throw new HttpError(409, `${kind} "${id}" has errors: ${e.asset.error}`);
    return e;
  }

  const wrap = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(409, (err as Error).message);
    }
  };

  /** Writes the library version of a copy asset into the project. Returns the repo-relative files changed. */
  function writeCopy(projectPath: string, kind: AssetKind, id: string, files: AssetFiles, before: ProjectState): { paths: string[]; changed: string[] } {
    const rel = copyTarget(kind, id);
    const abs = resolveInside(projectPath, rel);
    if (LIBRARY_LAYOUT[kind].shape === "file") {
      writeFileAtomic(abs, files[entryFile(kind, id)]!);
      return { paths: [rel], changed: [rel] };
    }
    for (const k of Object.keys(files)) resolveInside(projectPath, `${rel}/${k}`);
    replaceDirAtomic(abs, files);
    const paths = Object.keys(files).sort().map((k) => `${rel}/${k}`);
    const removed = before.paths.filter((p) => !paths.includes(p));
    return { paths, changed: [...paths, ...removed] };
  }

  function installOrUpdate(project: string, projectPath: string, req: InstallRequest, row: InstallRow | null): InstallResult {
    const { kind, id } = req;
    const lib = requireAsset(kind, id);
    const target = INSTALL_TARGETS[kind]!;
    const before = projectState(projectPath, kind, id, row);
    if (row) {
      const inst = toInstallation(row);
      if ((inst.state === "modified" || inst.state === "conflict") && !req.force) {
        throw new HttpError(409, `${target.mode === "copy" ? copyTarget(kind, id) : target.target} was changed in the project (${inst.state}); pass force to overwrite`);
      }
    }
    let paths: string[];
    let changed: string[];
    let merged: unknown = null;
    if (target.mode === "copy") {
      if (!row && before.files && filesHash(before.files) !== lib.asset.version && !req.force) {
        throw new HttpError(409, `${copyTarget(kind, id)} already exists and isn't from the library; pass force to overwrite`);
      }
      ({ paths, changed } = wrap(() => writeCopy(projectPath, kind, id, lib.files, before)));
    } else if (kind === "instruction") {
      if (!row && before.files && filesHash(before.files) !== lib.asset.version && !req.force)
        throw new HttpError(409, `AGENTS.md already has an untracked fragment for ${id}; pass force to overwrite`);
      const path = resolveInside(projectPath, target.target);
      const text = readRegularFile(path) ?? "";
      const body = lib.files["AGENTS.md"]!;
      wrap(() => writeFileAtomic(path, setInstruction(text, id, body)));
      paths = changed = [target.target];
      merged = body;
    } else if (kind === "mcp") {
      const doc = readJsonTarget(projectPath, target.target);
      const spec = lib.asset.meta;
      const existing = wrap(() => mcpEntry(doc, id));
      if (!row && existing !== null && !deepEqual(existing, spec) && !req.force) {
        throw new HttpError(409, `${target.target} already has a server "${id}" that isn't from the library; pass force to overwrite`);
      }
      const next = wrap(() => setMcpEntry(doc, id, spec));
      wrap(() => writeFileAtomic(resolveInside(projectPath, target.target), formatJson(next)));
      paths = [target.target];
      changed = [target.target];
      merged = spec;
    } else {
      let doc = readJsonTarget(projectPath, target.target);
      if (row?.merged && doc) doc = wrap(() => removeSettings(doc!, JSON.parse(row.merged!) as SettingsFragment)).doc;
      const { doc: next, added } = wrap(() => addSettings(doc, lib.asset.meta as SettingsProfileSpec));
      wrap(() => writeFileAtomic(resolveInside(projectPath, target.target), formatJson(next)));
      paths = [target.target];
      changed = [target.target];
      merged = added;
    }
    const saved = upsertRow(project, kind, id, lib.asset.version, paths, merged);
    return finish(project, saved, changed);
  }

  function push(project: string, projectPath: string, req: InstallRequest, row: InstallRow | null): InstallResult {
    const { kind, id } = req;
    const target = INSTALL_TARGETS[kind]!;
    if (target.mode === "merge" && !row) throw new HttpError(404, `${kind} "${id}" isn't installed in "${project}"`);
    const state = projectState(projectPath, kind, id, row);
    if (!state.files) throw new HttpError(409, `nothing to push: ${kind} "${id}" is missing in "${project}"`);
    const asset = save(kind, id, state.files);
    let merged: unknown = null;
    if (kind === "instruction") merged = state.files["AGENTS.md"];
    else if (kind === "mcp") merged = wrap(() => mcpEntry(readJsonTarget(projectPath, target.target), id));
    else if (kind === "settings") {
      const prev = row?.merged ? (JSON.parse(row.merged) as SettingsFragment) : {};
      merged = presentSettings(readJsonTarget(projectPath, target.target), prev);
    }
    const saved = upsertRow(project, kind, id, asset.version, target.mode === "copy" ? state.paths : [target.target], merged);
    return finish(project, saved, []);
  }

  function forget(project: string, projectPath: string, req: InstallRequest, row: InstallRow | null): InstallResult {
    const { kind, id } = req;
    if (!row) throw new HttpError(404, `${kind} "${id}" isn't installed in "${project}"`);
    const snapshot = toInstallation(row);
    const target = INSTALL_TARGETS[kind]!;
    const changed: string[] = [];
    // Merge kinds: take Odin's fragment back out of the shared file (only what is still exactly as written).
    if (kind === "instruction" && row.merged) {
      const path = resolveInside(projectPath, target.target);
      const text = readRegularFile(path) ?? "";
      const fragment = wrap(() => instructionFragment(text, id));
      if (fragment && filesHash({ "AGENTS.md": fragment.body }) === row.installed_version) {
        wrap(() => writeFileAtomic(path, setInstruction(text, id, null)));
        changed.push(target.target);
      }
    } else if (target.mode === "merge" && row.merged) {
      const doc = readJsonTarget(projectPath, target.target);
      if (doc) {
        let next: Record<string, unknown> | null = null;
        if (kind === "mcp") {
          const entry = wrap(() => mcpEntry(doc, id));
          if (entry !== null && deepEqual(entry, JSON.parse(row.merged))) next = removeMcpEntry(doc, id);
        } else {
          const r = wrap(() => removeSettings(doc, JSON.parse(row.merged!) as SettingsFragment));
          if (r.changed) next = r.doc;
        }
        if (next) {
          wrap(() => writeFileAtomic(resolveInside(projectPath, target.target), formatJson(next)));
          changed.push(target.target);
        }
      }
    }
    db.prepare("DELETE FROM installations WHERE project = ? AND kind = ? AND asset_id = ?").run(project, kind, id);
    if (changed.length) services.projects.noteWritten(project, changed);
    bus.emit({ type: "install.updated", installation: snapshot });
    return { installation: null, changed };
  }

  function finish(project: string, row: InstallRow, changed: string[]): InstallResult {
    if (changed.length) services.projects.noteWritten(project, changed);
    const installation = toInstallation(row);
    bus.emit({ type: "install.updated", installation });
    return { installation, changed };
  }

  // ── the service ───────────────────────────────────────────────────────────

  const sortAssets = (a: LibraryAsset, b: LibraryAsset) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);

  function installationsWhere(sql: string, ...args: string[]): Installation[] {
    return (db.prepare(`SELECT * FROM installations WHERE ${sql} ORDER BY project, kind, asset_id`).all(...args) as unknown as InstallRow[]).filter(row => isKind(row.kind)).map(toInstallation);
  }

  function versions(kind: AssetKind, id: string, current: string | null): AssetVersion[] {
    const rows = db.prepare("SELECT version, first_seen_at FROM library_versions WHERE kind = ? AND asset_id = ? ORDER BY first_seen_at DESC, rowid DESC").all(kind, id) as { version: string; first_seen_at: string }[];
    const count = (version: string): number => {
      if (kind === "agent") return (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE agent_version = ?").get(version) as { n: number }).n;
      if (kind === "template" && version === current) return (db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE template_id = ?").get(id) as { n: number }).n;
      return 0;
    };
    return rows.map((r) => ({ version: r.version, firstSeenAt: r.first_seen_at, sessionCount: count(r.version) }));
  }

  return {
    root,
    list(kind) {
      return [...cache.values()].map((e) => e.asset).filter((a) => !kind || a.kind === kind).sort(sortAssets);
    },
    get(kind, id) {
      return cache.get(key(kind, id))?.asset ?? null;
    },
    detail(kind, id) {
      const e = cache.get(key(kind, id));
      if (!e) return null;
      const out: AssetDetail = {
        asset: e.asset,
        files: { ...e.files },
        versions: versions(kind, id, e.asset.version),
        installs: installationsWhere("kind = ? AND asset_id = ?", kind, id),
      };
      return out;
    },
    files(kind, id, version) {
      const e = cache.get(key(kind, id));
      if (version === undefined || version === e?.asset.version) return e ? { ...e.files } : null;
      return versionFiles(kind, id, version);
    },
    save,
    remove,
    rescan,
    installations(project) {
      if (!services.projects.get(project)) throw new HttpError(404, `unknown project "${project}"`);
      return installationsWhere("project = ?", project);
    },
    async install(project, req) {
      if (!req || typeof req !== "object") throw new HttpError(400, "expected { kind, id, action }");
      checkKindId(req.kind, req.id);
      if (!INSTALL_TARGETS[req.kind]) throw new HttpError(400, `a ${req.kind} isn't installed into projects`);
      if (!["install", "update", "push", "forget"].includes(req.action)) throw new HttpError(400, `unknown action ${JSON.stringify(req.action)}`);
      const projectPath = projectRoot(project);
      const row = getRow(project, req.kind, req.id);
      switch (req.action) {
        case "install":
          return installOrUpdate(project, projectPath, req, row);
        case "update":
          if (!row) throw new HttpError(404, `${req.kind} "${req.id}" isn't installed in "${project}"`);
          return installOrUpdate(project, projectPath, req, row);
        case "push":
          return push(project, projectPath, req, row);
        case "forget":
          return forget(project, projectPath, req, row);
      }
    },
    projectFiles(project, kind, id) {
      checkKindId(kind, id);
      const projectPath = projectRoot(project);
      return projectState(projectPath, kind, id, getRow(project, kind, id)).files;
    },
    close() {
      if (timer) clearInterval(timer);
    },
  };
}
