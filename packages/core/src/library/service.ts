// LibraryService: plain files under <ODIN_HOME>/library (one directory per kind), versions in library_versions,
// installs into projects (copy or merge) in installations, drift recomputed from disk. docs/contracts.md#library.
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type {
  AssetDetail, AssetFiles, AssetKind, AssetVersion, DriftState, Installation, InstallRequest, InstallResult, LibraryAsset,
  PluginMemberKind, PluginMemberState, PluginOwnMember, PluginPreview, PluginRun, PluginSpec, SettingsProfileSpec,
} from "@odin/shared/api";
import { ASSET_ID_PATTERN, INSTALL_TARGETS, LIBRARY_KINDS, LIBRARY_LAYOUT, secretRefs } from "@odin/shared/library";
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
import { MAX_ASSET_FILE_BYTES, entryFile, filesError, parseAsset, pluginOwnFiles } from "./parse.ts";

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
  /** The id in the project when it differs from `asset_id` (a plugin's own member). */
  project_id: string | null;
  /** A library version a plugin pinned this member to. */
  pinned_version: string | null;
}

interface PluginRow {
  project: string;
  plugin_id: string;
  installed_version: string;
  runs_hash: string;
  members: string;
  installed_at: string;
}

/** A plugin member as stored: the library-side key, and the id it has in the project. */
interface StoredMember {
  kind: PluginMemberKind;
  asset: string;
  pid: string;
  origin: "own" | "library";
  /** The member was installed before the plugin was: forgetting the plugin leaves it. */
  adopted: boolean;
}

/** What `installMember` installs: where it comes from (`asset`, `pinned`) and where it goes (`pid`). */
interface Member {
  kind: AssetKind;
  asset: string;
  pid: string;
  pinned: string | null;
}

/** A plugin member resolved against the library now. */
interface Resolved extends Member {
  kind: PluginMemberKind;
  origin: "own" | "library";
  src: Entry;
}

const OWN_PREFIX = "plugin:";
const ownKey = (plugin: string, id: string) => `${OWN_PREFIX}${plugin}/${id}`;
const isOwnKey = (k: string) => k.startsWith(OWN_PREFIX);
const pidOf = (row: InstallRow) => row.project_id ?? row.asset_id;

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
const isKind = (k: unknown): k is AssetKind => typeof k === "string" && (LIBRARY_KINDS as string[]).includes(k);

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
    for (const kind of LIBRARY_KINDS) scanKind(kind, next);
    return next;
  }

  /** A plugin's own member as a library-shaped entry. Its versions are recorded under the plugin-scoped key. */
  function ownEntry(kind: AssetKind, assetKey: string): Entry | null {
    const [plugin, id] = assetKey.slice(OWN_PREFIX.length).split("/");
    const p = plugin && id ? cache.get(key("plugin", plugin)) : undefined;
    const m = p && pluginOwnFiles(p.files).members.find((x) => x.kind === kind && x.id === id);
    if (!m || !id) return null;
    const parsed = parseAsset(kind, id, m.files);
    const version = filesHash(m.files);
    const updatedAt = recordVersion(kind, assetKey, version, m.files);
    return { asset: { kind, id: assetKey, name: parsed.name, description: parsed.description, version, updatedAt, files: Object.keys(m.files).sort(), meta: parsed.meta, error: parsed.error }, files: m.files };
  }

  /** The library-side asset for an installation: a library asset (at a pinned version when asked) or a plugin's own member. */
  function source(kind: AssetKind, assetKey: string, pinned: string | null): Entry | null {
    if (isOwnKey(assetKey)) return ownEntry(kind, assetKey);
    const current = cache.get(key(kind, assetKey)) ?? null;
    if (!pinned || current?.asset.version === pinned) return current;
    const files = versionFiles(kind, assetKey, pinned);
    if (!files) return null;
    const parsed = parseAsset(kind, assetKey, files);
    const at = firstSeen.get(kind, assetKey, pinned) as { first_seen_at: string } | undefined;
    return { asset: { kind, id: assetKey, name: parsed.name, description: parsed.description, version: pinned, updatedAt: at?.first_seen_at ?? nowIso(), files: Object.keys(files).sort(), meta: parsed.meta, error: parsed.error }, files };
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
    const files = (version && versionFiles(kind, id, version)) || source(kind, id, null)?.files || null;
    if (!files) return { name: id, description: "" };
    const p = parseAsset(kind, id, files);
    return { name: p.name, description: p.description };
  }

  /** The installed version's spec (merge kinds), from library_versions. */
  function installedSpec(row: InstallRow): Record<string, unknown> | null {
    const files = versionFiles(row.kind, row.asset_id, row.installed_version);
    if (!files) return null;
    return parseAsset(row.kind, pidOf(row), files).meta;
  }

  /** `id` is the id in the project; the library-side asset is `row.asset_id` when there is a row. */
  function projectState(projectPath: string, kind: AssetKind, id: string, row: InstallRow | null): ProjectState {
    const target = INSTALL_TARGETS[kind];
    if (!target) throw new HttpError(400, `a ${kind} isn't installed into projects`);
    if (target.mode === "bundle") throw new HttpError(400, `a ${kind} has no files of its own in a project`);
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
    const { name, description } = labels(kind, row?.asset_id ?? id, row?.installed_version ?? null);
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
    const spec = ((row && installedSpec(row)) ?? (row?.merged ? JSON.parse(row.merged) : null) ?? (source(kind, row?.asset_id ?? id, row?.pinned_version ?? null)?.asset.meta ?? {})) as SettingsProfileSpec;
    const present = presentSettings(doc, spec);
    const total = fragmentSize(spec);
    const have = fragmentSize(present);
    if (!doc || (total > 0 && have === 0)) return { files: null, paths: [target.target], unchanged: false };
    return { files: { [file]: formatJson({ name, description, ...present, ...(spec.codex ? { codex: spec.codex } : {}), ...(spec.opencode ? { opencode: spec.opencode } : {}) }) }, paths: [target.target], unchanged: have === total };
  }

  function toInstallation(row: InstallRow): Installation {
    const lib = source(row.kind, row.asset_id, row.pinned_version);
    const libraryVersion = lib?.asset.version ?? null;
    const ref = services.projects.get(row.project);
    let state: ProjectState = { files: null, paths: JSON.parse(row.paths) as string[] };
    if (ref && !ref.missing) {
      try {
        state = projectState(ref.path, row.kind, pidOf(row), row);
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

  function upsertRow(project: string, kind: AssetKind, id: string, version: string, paths: string[], merged: unknown, pid: string | null = null, pinned: string | null = null): InstallRow {
    db.prepare(
      `INSERT INTO installations (project, kind, asset_id, installed_version, paths, merged, installed_at, project_id, pinned_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, kind, asset_id) DO UPDATE SET installed_version = excluded.installed_version, paths = excluded.paths,
       merged = excluded.merged, installed_at = excluded.installed_at, project_id = excluded.project_id, pinned_version = excluded.pinned_version`,
    ).run(project, kind, id, version, JSON.stringify(paths), merged === undefined || merged === null ? null : JSON.stringify(merged), nowIso(), pid === id ? null : pid, pinned);
    return getRow(project, kind, id)!;
  }

  function requireSource(m: Member): Entry {
    const e = source(m.kind, m.asset, m.pinned);
    if (!e) throw new HttpError(404, `no ${m.kind} "${m.pid}" in the library${m.pinned ? ` at version ${m.pinned.slice(0, 8)}` : ""}`);
    if (e.asset.error) throw new HttpError(409, `${m.kind} "${m.pid}" has errors: ${e.asset.error}`);
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

  const NOTHING: InstallResult = { installation: null, changed: [] };

  /**
   * Installs or updates one asset into the project. `dry` runs every check and writes nothing (a plugin checks all of
   * its members before it writes any).
   */
  function installMember(project: string, projectPath: string, m: Member, row: InstallRow | null, force: boolean, dry = false): InstallResult {
    const { kind, pid: id } = m;
    const lib = requireSource(m);
    const target = INSTALL_TARGETS[kind]!;
    const before = projectState(projectPath, kind, id, row);
    const other = !row ? claimedBy(project, kind, id, m.asset) : null;
    if (other) throw new HttpError(409, `${kind} "${id}" in "${project}" is already installed from ${other}`);
    if (row) {
      const inst = toInstallation(row);
      if ((inst.state === "modified" || inst.state === "conflict") && !force) {
        throw new HttpError(409, `${target.mode === "copy" ? copyTarget(kind, id) : target.target} was changed in the project (${inst.state}); pass force to overwrite`);
      }
    }
    let paths: string[];
    let changed: string[];
    let merged: unknown = null;
    if (target.mode === "copy") {
      if (!row && before.files && filesHash(before.files) !== lib.asset.version && !force) {
        throw new HttpError(409, `${copyTarget(kind, id)} already exists and isn't from the library; pass force to overwrite`);
      }
      if (dry) return NOTHING;
      ({ paths, changed } = wrap(() => writeCopy(projectPath, kind, id, lib.files, before)));
    } else if (kind === "instruction") {
      if (!row && before.files && filesHash(before.files) !== lib.asset.version && !force)
        throw new HttpError(409, `AGENTS.md already has an untracked fragment for ${id}; pass force to overwrite`);
      if (dry) return NOTHING;
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
      if (!row && existing !== null && !deepEqual(existing, spec) && !force) {
        throw new HttpError(409, `${target.target} already has a server "${id}" that isn't from the library; pass force to overwrite`);
      }
      if (dry) return NOTHING;
      const next = wrap(() => setMcpEntry(doc, id, spec));
      wrap(() => writeFileAtomic(resolveInside(projectPath, target.target), formatJson(next)));
      paths = [target.target];
      changed = [target.target];
      merged = spec;
    } else {
      if (dry) return NOTHING;
      let doc = readJsonTarget(projectPath, target.target);
      if (row?.merged && doc) doc = wrap(() => removeSettings(doc!, JSON.parse(row.merged!) as SettingsFragment)).doc;
      const { doc: next, added } = wrap(() => addSettings(doc, lib.asset.meta as SettingsProfileSpec));
      wrap(() => writeFileAtomic(resolveInside(projectPath, target.target), formatJson(next)));
      paths = [target.target];
      changed = [target.target];
      merged = added;
    }
    const saved = upsertRow(project, kind, m.asset, lib.asset.version, paths, merged, id, m.pinned);
    return finish(project, saved, changed, !isOwnKey(m.asset));
  }

  function installOrUpdate(project: string, projectPath: string, req: InstallRequest, row: InstallRow | null): InstallResult {
    return installMember(project, projectPath, { kind: req.kind, asset: req.id, pid: req.id, pinned: row?.pinned_version ?? null }, row, !!req.force);
  }

  /** The other installation (as a name) already using this id in the project, if any: two rows must not own one target. */
  function claimedBy(project: string, kind: AssetKind, pid: string, asset: string): string | null {
    const rows = db.prepare("SELECT asset_id, project_id FROM installations WHERE project = ? AND kind = ? AND asset_id <> ?").all(project, kind, asset) as { asset_id: string; project_id: string | null }[];
    const hit = rows.find((r) => (r.project_id ?? r.asset_id) === pid);
    if (!hit) return null;
    return isOwnKey(hit.asset_id) ? `plugin ${hit.asset_id.slice(OWN_PREFIX.length).split("/")[0]}` : `library ${kind} ${hit.asset_id}`;
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
    if (!row) throw new HttpError(404, `${req.kind} "${req.id}" isn't installed in "${project}"`);
    const snapshot = toInstallation(row);
    const changed = forgetRow(project, projectPath, row);
    if (changed.length) services.projects.noteWritten(project, changed);
    bus.emit({ type: "install.updated", installation: snapshot });
    return { installation: null, changed };
  }

  /** Takes an installation out of the project (copy files stay; Odin's merged fragments go) and drops the row. */
  function forgetRow(project: string, projectPath: string, row: InstallRow): string[] {
    const { kind } = row;
    const id = pidOf(row);
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
    db.prepare("DELETE FROM installations WHERE project = ? AND kind = ? AND asset_id = ?").run(project, kind, row.asset_id);
    return changed;
  }

  function finish(project: string, row: InstallRow, changed: string[], announce = true): InstallResult {
    if (changed.length) services.projects.noteWritten(project, changed);
    const installation = toInstallation(row);
    if (announce) bus.emit({ type: "install.updated", installation });
    return { installation, changed };
  }

  // ── plugins ───────────────────────────────────────────────────────────────

  const getPluginRow = (project: string, id: string): PluginRow | null =>
    (db.prepare("SELECT * FROM plugin_installations WHERE project = ? AND plugin_id = ?").get(project, id) as PluginRow | undefined) ?? null;

  interface PluginPlan {
    id: string;
    members: Resolved[];
    /** Included assets the library cannot supply, as `kind/id`. */
    missing: string[];
    /** Hash of the plugin's files and the versions of everything it takes from the library. */
    version: string;
    runs: PluginRun[];
  }

  /** What a member would run or add: hooks, local MCP commands, remote servers. */
  function runsOf(members: Resolved[]): PluginRun[] {
    const runs: PluginRun[] = [];
    for (const m of members) {
      const member = `${m.kind}/${m.pid}`;
      const meta = m.src.asset.meta as { type?: string; command?: string; args?: string[]; url?: string; oauth?: unknown; hooks?: Record<string, unknown> };
      if (m.kind === "settings" && meta.hooks) {
        for (const [event, value] of Object.entries(meta.hooks)) runs.push({ kind: "hook", member, text: `${event}: ${JSON.stringify(value)}` });
      } else if (m.kind === "mcp") {
        if (meta.type === "stdio") runs.push({ kind: "command", member, text: [meta.command, ...(meta.args ?? [])].join(" ") });
        else runs.push({ kind: "remote", member, text: `${meta.url ?? ""}${meta.oauth ? " (signs in with OAuth)" : ""}` });
      }
    }
    return runs;
  }

  /** Hash of what needs confirming (hooks and local commands); remote servers run nothing here. */
  const runsHash = (runs: PluginRun[]) => filesHash({ runs: JSON.stringify(runs.filter((r) => r.kind !== "remote")) });

  function resolvePlugin(id: string): PluginPlan {
    const entry = cache.get(key("plugin", id));
    if (!entry) throw new HttpError(404, `no plugin "${id}" in the library`);
    if (entry.asset.error) throw new HttpError(409, `plugin "${id}" has errors: ${entry.asset.error}`);
    const meta = entry.asset.meta as unknown as PluginSpec & { own: PluginOwnMember[] };
    const members: Resolved[] = [];
    const missing: string[] = [];
    for (const own of meta.own) {
      const asset = ownKey(id, own.id);
      const src = ownEntry(own.kind, asset);
      if (src) members.push({ kind: own.kind, asset, pid: own.id, pinned: null, origin: "own", src });
    }
    for (const inc of meta.includes) {
      const src = source(inc.kind, inc.id, inc.version ?? null);
      if (!src || src.asset.error) missing.push(`${inc.kind}/${inc.id}${inc.version ? `@${inc.version.slice(0, 8)}` : ""}${src?.asset.error ? " (has errors)" : ""}`);
      else members.push({ kind: inc.kind, asset: inc.id, pid: inc.id, pinned: inc.version ?? null, origin: "library", src });
    }
    const versions: AssetFiles = { plugin: entry.asset.version };
    for (const m of members) versions[`${m.kind}/${m.asset}`] = m.src.asset.version;
    return { id, members, missing, version: filesHash(versions), runs: runsOf(members) };
  }

  function previewOf(project: string, plan: PluginPlan): PluginPreview {
    const refs = new Set<string>();
    const oauth: string[] = [];
    for (const m of plan.members) {
      if (m.kind !== "mcp") continue;
      const spec = m.src.asset.meta as { url?: unknown; args?: unknown; env?: unknown; headers?: unknown; oauth?: unknown };
      const strings = [spec.url, ...(Array.isArray(spec.args) ? spec.args : []), ...Object.values((spec.env ?? {}) as object), ...Object.values((spec.headers ?? {}) as object)];
      for (const text of strings) if (typeof text === "string") for (const name of secretRefs(text)) refs.add(name);
      if (spec.oauth) oauth.push(m.pid);
    }
    let set = new Set<string>();
    try {
      set = new Set(services.secrets.list().secrets.map((x) => x.name));
    } catch {
      // no vault in this setup: every secret reads as unset
    }
    const needsConfirm = plan.runs.some((r) => r.kind !== "remote");
    return {
      project, plugin: plan.id, version: plan.version,
      members: plan.members.map((m) => ({ kind: m.kind, id: m.pid, origin: m.origin, version: m.src.asset.version })),
      runs: plan.runs, missing: plan.missing,
      secrets: [...refs].sort().map((name) => ({ name, set: set.has(name) })),
      oauth, confirm: needsConfirm ? filesHash({ preview: JSON.stringify({ plugin: plan.id, version: plan.version, runs: plan.runs }) }).slice(0, 16) : null,
    };
  }

  const storedMembers = (row: PluginRow) => JSON.parse(row.members) as StoredMember[];

  /** Another plugin installed in the project lists this member. */
  function listedByOther(project: string, m: { kind: string; asset: string }, plugin: string): boolean {
    const rows = db.prepare("SELECT * FROM plugin_installations WHERE project = ? AND plugin_id <> ?").all(project, plugin) as unknown as PluginRow[];
    return rows.some((r) => storedMembers(r).some((x) => x.kind === m.kind && x.asset === m.asset));
  }

  /** Takes a plugin member out of the project unless it was there first or another plugin still wants it. */
  function release(project: string, projectPath: string, m: StoredMember, plugin: string): string[] {
    if (m.adopted || listedByOther(project, m, plugin)) return [];
    const row = getRow(project, m.kind, m.asset);
    return row ? forgetRow(project, projectPath, row) : [];
  }

  const ROLLUP: (DriftState | "not-installed")[] = ["conflict", "modified", "missing", "not-installed", "update-available", "current"];

  function toPluginInstallation(row: PluginRow): Installation {
    let plan: PluginPlan | null = null;
    try {
      plan = resolvePlugin(row.plugin_id);
    } catch {
      // deleted or broken in the library: reported as no library version
    }
    const stored = storedMembers(row);
    const members: PluginMemberState[] = [];
    const paths = new Set<string>();
    const seen = new Set<string>();
    for (const m of stored) {
      const mr = getRow(row.project, m.kind, m.asset);
      const inst = mr ? toInstallation(mr) : null;
      for (const path of inst?.paths ?? []) paths.add(path);
      seen.add(`${m.kind}/${m.asset}`);
      members.push({ kind: m.kind, id: m.pid, origin: m.origin, state: inst ? inst.state : "missing" });
    }
    for (const m of plan?.members ?? []) if (!seen.has(`${m.kind}/${m.asset}`)) members.push({ kind: m.kind, id: m.pid, origin: m.origin, state: "not-installed" });
    let state: DriftState = "current";
    const worst = ROLLUP.find((s) => members.some((m) => m.state === s));
    if (worst && worst !== "current") state = worst === "not-installed" ? "update-available" : worst;
    if (state === "current" && plan && plan.version !== row.installed_version) state = "update-available";
    return {
      project: row.project, kind: "plugin", id: row.plugin_id, installedVersion: row.installed_version, libraryVersion: plan?.version ?? null,
      projectVersion: null, state, paths: [...paths].sort(), installedAt: row.installed_at, members,
    };
  }

  function installPlugin(project: string, projectPath: string, req: InstallRequest, prev: PluginRow | null): InstallResult {
    const plan = resolvePlugin(req.id);
    if (plan.missing.length) throw new HttpError(409, `plugin "${req.id}" includes assets the library doesn't have: ${plan.missing.join(", ")}`);
    const preview = previewOf(project, plan);
    if (preview.confirm !== null && (!prev || prev.runs_hash !== runsHash(plan.runs)) && req.confirm !== preview.confirm) {
      const n = plan.runs.filter((r) => r.kind !== "remote").length;
      throw new HttpError(409, `plugin "${req.id}" adds ${n} hook${n === 1 ? "" : "s"} or local command${n === 1 ? "" : "s"}${prev ? " that changed since you confirmed" : ""}: send action "preview", read it, and pass its confirm`);
    }
    const before = prev ? storedMembers(prev) : [];
    // Every member is checked before any is written, so a conflict leaves the project as it was.
    for (const m of plan.members) installMember(project, projectPath, m, getRow(project, m.kind, m.asset), !!req.force, true);
    const stored: StoredMember[] = [];
    const changed: string[] = [];
    for (const m of plan.members) {
      const existing = getRow(project, m.kind, m.asset);
      const was = before.find((b) => b.kind === m.kind && b.asset === m.asset);
      const adopted = was ? was.adopted : m.origin === "library" && !!existing && !listedByOther(project, m, req.id);
      changed.push(...installMember(project, projectPath, m, existing, !!req.force).changed);
      stored.push({ kind: m.kind, asset: m.asset, pid: m.pid, origin: m.origin, adopted });
    }
    for (const b of before) if (!plan.members.some((m) => m.kind === b.kind && m.asset === b.asset)) changed.push(...release(project, projectPath, b, req.id));
    db.prepare(
      `INSERT INTO plugin_installations (project, plugin_id, installed_version, runs_hash, members, installed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (project, plugin_id) DO UPDATE SET installed_version = excluded.installed_version, runs_hash = excluded.runs_hash,
       members = excluded.members, installed_at = excluded.installed_at`,
    ).run(project, req.id, plan.version, runsHash(plan.runs), JSON.stringify(stored), nowIso());
    const installation = toPluginInstallation(getPluginRow(project, req.id)!);
    const unique = [...new Set(changed)];
    if (unique.length) services.projects.noteWritten(project, unique);
    bus.emit({ type: "install.updated", installation });
    return { installation, changed: unique };
  }

  function forgetPlugin(project: string, projectPath: string, req: InstallRequest, row: PluginRow | null): InstallResult {
    if (!row) throw new HttpError(404, `plugin "${req.id}" isn't installed in "${project}"`);
    const snapshot = toPluginInstallation(row);
    const changed: string[] = [];
    for (const m of storedMembers(row)) changed.push(...release(project, projectPath, m, req.id));
    db.prepare("DELETE FROM plugin_installations WHERE project = ? AND plugin_id = ?").run(project, req.id);
    const unique = [...new Set(changed)];
    if (unique.length) services.projects.noteWritten(project, unique);
    bus.emit({ type: "install.updated", installation: snapshot });
    return { installation: null, changed: unique };
  }

  function pluginInstallations(where: string, ...args: string[]): Installation[] {
    return (db.prepare(`SELECT * FROM plugin_installations WHERE ${where} ORDER BY project, plugin_id`).all(...args) as unknown as PluginRow[]).map(toPluginInstallation);
  }

  // ── the service ───────────────────────────────────────────────────────────

  const sortAssets = (a: LibraryAsset, b: LibraryAsset) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id);

  function installationsWhere(sql: string, ...args: string[]): Installation[] {
    // A plugin's own members are shown under the plugin, not as installations of their own.
    return (db.prepare(`SELECT * FROM installations WHERE ${sql} AND asset_id NOT LIKE '${OWN_PREFIX}%' ORDER BY project, kind, asset_id`).all(...args) as unknown as InstallRow[]).filter(row => isKind(row.kind)).map(toInstallation);
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
        installs: kind === "plugin" ? pluginInstallations("plugin_id = ?", id) : installationsWhere("kind = ? AND asset_id = ?", kind, id),
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
      return [...installationsWhere("project = ?", project), ...pluginInstallations("project = ?", project)];
    },
    async install(project, req) {
      if (!req || typeof req !== "object") throw new HttpError(400, "expected { kind, id, action }");
      checkKindId(req.kind, req.id);
      if (!INSTALL_TARGETS[req.kind]) throw new HttpError(400, `a ${req.kind} isn't installed into projects`);
      if (!["install", "update", "push", "forget", "preview"].includes(req.action)) throw new HttpError(400, `unknown action ${JSON.stringify(req.action)}`);
      if (req.confirm !== undefined && typeof req.confirm !== "string") throw new HttpError(400, "confirm must be text");
      const projectPath = projectRoot(project);
      if (req.kind === "plugin") {
        const prev = getPluginRow(project, req.id);
        switch (req.action) {
          case "preview":
            return { installation: prev ? toPluginInstallation(prev) : null, changed: [], preview: previewOf(project, resolvePlugin(req.id)) };
          case "install":
            if (prev && !req.force) throw new HttpError(409, `plugin "${req.id}" is already installed in "${project}": use update`);
            return installPlugin(project, projectPath, req, prev);
          case "update":
            if (!prev) throw new HttpError(404, `plugin "${req.id}" isn't installed in "${project}"`);
            return installPlugin(project, projectPath, req, prev);
          case "forget":
            return forgetPlugin(project, projectPath, req, prev);
          case "push":
            throw new HttpError(400, "a plugin can't be pushed back from a project");
        }
      }
      if (req.action === "preview") throw new HttpError(400, "only plugins have a preview");
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
