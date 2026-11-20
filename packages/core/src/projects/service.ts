// ProjectsService: the registry of projects (registered directories), their read-only PROJECT.md, agents, git state
// and worktrees. SQLite holds the last-read state; refresh() re-reads disk and git and emits project.updated when
// something changed. Odin never writes into a project's files (docs/contracts.md#projects).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CreateProjectRequest, ProjectAgent, ProjectBranch, ProjectCommands, ProjectSettings, ProjectSourceSelection, ProjectWorktree, ProjectWorktrees, PullRef, UpdateProjectSettingsRequest, UpdateProjectSourcesRequest } from "@odin/shared/api";
import { parseProjectSources } from "@odin/shared/api";
import { AGENT_ID_PATTERN } from "@odin/shared/agents";
import { PROJECT_NAME_PATTERN } from "@odin/shared/labels";
import { slugify } from "@odin/shared/session";
import { AGENTS_DIR, MAX_AGENT_BYTES, parseAgentFile } from "../agents/parse.ts";
import { expandHome } from "../config.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { HttpError } from "../http/util.ts";
import { validBranchName } from "../git-policy.ts";
import type { Deps, ProjectRef, ProjectsService, Services } from "../services.ts";
import {
  EMPTY_GIT, GitError, aheadBehind, baseRemote, cloneRepo, listRemotes, defaultBase, git, initRepo, isGitRepo, listBranches, listWorktrees, mergedBranches, readGitState, statusPaths,
} from "./git.ts";
import { readProject, repoFromRemote, type ManifestFields, type SettingOverrides } from "./context.ts";

const PROJECT_FILE = "PROJECT.md";
const MAX_MANIFEST_BYTES = 256 * 1024;
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMAND_KEYS = ["install", "check", "build"] as const;

/** What PROJECT.md says (only these keys are read), plus the default branch and origin repo detected in git. */
interface Manifest extends ManifestFields {}

type Overrides = SettingOverrides;

interface Row {
  name: string;
  path: string;
  settings: string;
  manifest: string;
  manifest_error: string | null;
  git: string;
  agents: string;
  written_files: string;
  sources: string | null;
  source_stamp: string;
  missing: number;
  created_at: string;
  updated_at: string;
}

/** Real path of the longest existing ancestor plus the rest, so a path that's gone still compares sensibly. */
function realPathLoose(p: string): string {
  const tail: string[] = [];
  let cur = resolve(p);
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p);
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/** `target` is `root` or below it. Both already resolved. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

function readCapped(file: string): string | "missing" | "large" {
  try {
    const st = statSync(file);
    if (!st.isFile()) return "missing";
    if (st.size > MAX_MANIFEST_BYTES) return "large";
    return readFileSync(file, "utf8");
  } catch {
    return "missing";
  }
}

/** PROJECT.md → the five known values. Anything unreadable is reported and skipped; the rest still applies. */
export function readManifest(text: string): { manifest: Manifest; error: string | null } {
  const fm = parseFrontmatter(text, PROJECT_FILE);
  const errors = [...fm.errors];
  const manifest: Manifest = {};
  const data = fm.data ?? {};
  const str = (key: string): string | undefined => {
    const v = data[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "string") {
      errors.push(`${key} must be a single value`);
      return undefined;
    }
    return v.trim() || undefined;
  };
  const title = str("title");
  if (title) manifest.title = title.replace(/\s+/g, " ");
  const description = str("description");
  if (description) manifest.description = description;
  const repo = str("repo");
  if (repo) {
    if (REPO_PATTERN.test(repo)) manifest.repo = repo;
    else errors.push("repo must look like owner/name");
  }
  const branch = str("default_branch");
  if (branch) {
    if (validBranchName(branch)) manifest.defaultBranch = branch;
    else errors.push("default_branch isn't a valid branch name");
  }
  const commands = data.commands;
  if (commands !== undefined && commands !== null) {
    if (typeof commands !== "object" || Array.isArray(commands)) errors.push("commands must be a map of install, check and build");
    else {
      const out: ProjectCommands = {};
      for (const key of COMMAND_KEYS) {
        const v = commands[key];
        if (typeof v === "string" && v.trim()) out[key] = v.trim();
      }
      if (Object.keys(out).length) manifest.commands = out;
    }
  }
  return { manifest, error: errors.length ? errors.join("; ") : null };
}

function checkOverrides(req: UpdateProjectSettingsRequest): { set: Overrides; clear: string[] } {
  if (req === null || typeof req !== "object" || Array.isArray(req)) throw new HttpError(400, "expected a JSON object");
  const set: Record<string, unknown> = {};
  const clear: string[] = [];
  const known = ["title", "description", "repo", "defaultBranch", "commands", "githubEnabled", "defaultWorktree"];
  for (const key of Object.keys(req)) {
    if (!known.includes(key)) throw new HttpError(400, `unknown setting "${key}"`);
    const v = (req as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (v === null) {
      clear.push(key);
      continue;
    }
    if (key === "githubEnabled") {
      if (typeof v !== "boolean") throw new HttpError(400, "githubEnabled must be true or false");
      set.githubEnabled = v;
      continue;
    }
    if (key === "defaultWorktree") {
      if (typeof v !== "boolean") throw new HttpError(400, "defaultWorktree must be true or false");
      set.defaultWorktree = v;
      continue;
    }
    if (key === "commands") {
      if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "commands must be an object");
      const out: ProjectCommands = {};
      for (const [k, c] of Object.entries(v)) {
        if (!(COMMAND_KEYS as readonly string[]).includes(k)) throw new HttpError(400, `unknown command "${k}"`);
        if (c === undefined || c === null || c === "") continue;
        if (typeof c !== "string" || c.length > 2000) throw new HttpError(400, `commands.${k} must be a string`);
        out[k as keyof ProjectCommands] = c.trim();
      }
      set.commands = out;
      continue;
    }
    if (typeof v !== "string") throw new HttpError(400, `${key} must be a string`);
    const text = v.replace(/\r\n/g, "\n").trim();
    if (key === "title" && (!text || text.length > 200)) throw new HttpError(400, "title must be 1 to 200 characters");
    if (key === "description" && text.length > 2000) throw new HttpError(400, "description is too long");
    if (key === "repo" && !REPO_PATTERN.test(text)) throw new HttpError(400, "repo must look like owner/name");
    if (key === "defaultBranch" && !validBranchName(text)) throw new HttpError(400, "defaultBranch isn't a valid branch name");
    set[key] = text;
  }
  return { set: set as Overrides, clear };
}

function savedSources(row: { sources: string | null }): ProjectSourceSelection | null {
  if (!row.sources) return null;
  const parsed = parseProjectSources(JSON.parse(row.sources));
  return parsed.ok ? parsed.selection : null;
}

function readAgents(path: string): ProjectAgent[] {
  const dir = join(path, AGENTS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const out: ProjectAgent[] = [];
  for (const file of names) {
    const id = file.slice(0, -3);
    if (!AGENT_ID_PATTERN.test(id)) continue;
    const full = join(dir, file);
    let content: string;
    try {
      const st = lstatSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_AGENT_BYTES) {
        out.push({ id, name: id, description: "", model: null, tools: null, path: `${AGENTS_DIR}/${file}`, version: "", libraryId: null, error: "the file is too large" });
        continue;
      }
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    const a = parseAgentFile(id, content);
    out.push({ id, name: a.name, description: a.description, model: a.model, tools: a.tools, path: `${AGENTS_DIR}/${file}`, version: a.version, libraryId: null, error: a.error });
  }
  return out;
}

async function detectDefaultBranch(path: string): Promise<string | undefined> {
  const current = (await git(path, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
  const remotes = new Set([await baseRemote(path, current || null), await baseRemote(path)]);
  for (const remote of remotes) {
    if (!remote) continue;
    const head = (await git(path, ["symbolic-ref", "--short", "-q", `refs/remotes/${remote}/HEAD`]).catch(() => "")).trim();
    if (head.startsWith(`${remote}/`)) return head.slice(remote.length + 1);
  }
  return current || undefined;
}

async function detectOriginRepo(path: string): Promise<string | undefined> {
  try {
    const current = (await git(path, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim();
    const remote = await baseRemote(path, current || null);
    if (!remote) return undefined;
    return repoFromRemote((await git(path, ["remote", "get-url", remote])).trim()) ?? undefined;
  } catch {
    return undefined;
  }
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(() => true, () => false);
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
}

function parseWorktrees(out: string): WorktreeEntry[] {
  const list: WorktreeEntry[] = [];
  for (const block of out.split(/\n\n+/)) {
    let path: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    }
    if (path) list.push({ path, branch });
  }
  return list;
}

/** Folders of a repo's linked worktrees, read from `.git/worktrees/<id>/gitdir` without running git. */
function linkedWorktreeFolders(repoPath: string): string[] {
  const dir = join(repoPath, ".git", "worktrees");
  const out: string[] = [];
  try {
    for (const id of readdirSync(dir)) {
      try {
        const gitdir = readFileSync(join(dir, id, "gitdir"), "utf8").trim();
        if (gitdir) out.push(dirname(gitdir));
      } catch {
        // a half-written or pruned entry
      }
    }
  } catch {
    // no linked worktrees
  }
  return out;
}

/** Session states that may hold a live harness handle: a worktree under one of them isn't removed. */
const LIVE_STATES = ["idle", "running", "waiting"];

export function createProjectsService(deps: Deps, services?: Services): ProjectsService {
  const { db, bus, config } = deps;
  const now = () => deps.now().toISOString();

  const getRow = (name: string) => db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as unknown as Row | undefined;
  const allRows = () => db.prepare("SELECT * FROM projects ORDER BY name").all() as unknown as Row[];
  const need = (name: string): Row => {
    const row = getRow(name);
    if (!row) throw new HttpError(404, `unknown project "${name}"`);
    return row;
  };

  const inflight = new Map<string, { promise: Promise<void>; again: boolean }>();
  const worktreeLocks = new Map<string, Promise<unknown>>();
  let closed = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const viewOf = (row: Row) => readProject(
    row.missing === 1 ? null : row.path,
    row.name,
    JSON.parse(row.settings) as Overrides,
    JSON.parse(row.manifest) as Manifest,
    savedSources(row),
  );
  const settingsOf = (row: Row): ProjectSettings => viewOf(row).settings;
  const toRef = (row: Row): ProjectRef => ({
    name: row.name,
    path: row.path,
    settings: settingsOf(row),
    manifestError: row.manifest_error,
    missing: row.missing === 1,
  });

  /** Agents as stored, with libraryId from the installations table (read live: installs don't touch these rows). */
  function agentsOf(row: Row): ProjectAgent[] {
    const installed = new Set(
      (db.prepare("SELECT asset_id FROM installations WHERE project = ? AND kind = 'agent'").all(row.name) as { asset_id: string }[]).map((r) => r.asset_id),
    );
    return (JSON.parse(row.agents) as ProjectAgent[]).map((a) => ({ ...a, libraryId: installed.has(a.id) ? a.id : null }));
  }

  // ── refresh ───────────────────────────────────────────────────────────────

  async function readOnce(name: string): Promise<void> {
    const row = getRow(name);
    if (!row) return;
    const missing = !existsSync(row.path) || !statSync(row.path).isDirectory();

    let manifest: Manifest = {};
    let manifestError: string | null = null;
    let agents: ProjectAgent[] = [];
    let state = { ...EMPTY_GIT };
    let dirtyPaths: string[] = [];
    if (missing) {
      manifest = JSON.parse(row.manifest) as Manifest;
      agents = JSON.parse(row.agents) as ProjectAgent[];
      manifestError = existsSync(row.path) ? "the folder is no longer a git repository" : `path not found: ${row.path}`;
    } else {
      const text = readCapped(join(row.path, PROJECT_FILE));
      if (text === "large") manifestError = `${PROJECT_FILE} is too large`;
      else if (text !== "missing") ({ manifest, error: manifestError } = readManifest(text));
      manifest.detectedDefaultBranch = await detectDefaultBranch(row.path);
      manifest.detectedRepo = await detectOriginRepo(row.path);
      agents = readAgents(row.path);
      const overrides = JSON.parse(row.settings) as Overrides;
      const effectiveBranch = overrides.defaultBranch ?? manifest.defaultBranch ?? manifest.detectedDefaultBranch ?? "main";
      ({ state, dirtyPaths } = await readGitState(row.path, effectiveBranch).catch(() => ({ state: { ...EMPTY_GIT }, dirtyPaths: [] as string[] })));
    }
    if (closed || !getRow(name)) return;

    const written = (JSON.parse(row.written_files) as string[]).filter((p) => missing || dirtyPaths.includes(p));
    const read = readProject(missing ? null : row.path, name, JSON.parse(row.settings) as Overrides, manifest, savedSources(row));
    const next = {
      manifest: JSON.stringify(manifest),
      manifest_error: manifestError,
      git: JSON.stringify(state),
      agents: JSON.stringify(agents),
      written_files: JSON.stringify(written),
      source_stamp: read.stamp,
      missing: missing ? 1 : 0,
    };
    const changed = next.manifest !== row.manifest
      || next.manifest_error !== row.manifest_error
      || next.git !== row.git
      || next.agents !== row.agents
      || next.written_files !== row.written_files
      || next.source_stamp !== (row.source_stamp ?? "")
      || next.missing !== row.missing;
    if (!changed) return;
    db.prepare("UPDATE projects SET manifest = ?, manifest_error = ?, git = ?, agents = ?, written_files = ?, source_stamp = ?, missing = ?, updated_at = ? WHERE name = ?").run(
      next.manifest, next.manifest_error, next.git, next.agents, next.written_files, next.source_stamp, next.missing, now(), name,
    );
    bus.emit({ type: "project.updated", project: name });
  }

  function refresh(name: string): Promise<void> {
    if (!getRow(name)) return Promise.reject(new HttpError(404, `unknown project "${name}"`));
    const running = inflight.get(name);
    if (running) {
      // A change that landed while a read was underway may not be in it: run once more after.
      running.again = true;
      return running.promise;
    }
    const entry = { again: false, promise: Promise.resolve() };
    entry.promise = (async () => {
      try {
        do {
          entry.again = false;
          await readOnce(name);
        } while (entry.again && !closed);
      } finally {
        inflight.delete(name);
      }
    })();
    inflight.set(name, entry);
    return entry.promise;
  }

  async function refreshAll(): Promise<void> {
    for (const row of allRows()) {
      if (closed) return;
      await refresh(row.name).catch((err) => console.error(`refresh ${row.name} failed:`, err));
    }
  }

  if (config.projectsRescanMs > 0) {
    timer = setInterval(() => void refreshAll(), config.projectsRescanMs);
    timer.unref();
    setTimeout(() => void refreshAll(), 0).unref();
  }

  // ── worktrees ─────────────────────────────────────────────────────────────

  const worktreeRoot = (name: string) => join(config.worktreesDir, name);

  function locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const run = (worktreeLocks.get(name) ?? Promise.resolve()).catch(() => {}).then(fn);
    worktreeLocks.set(name, run);
    return run.finally(() => {
      if (worktreeLocks.get(name) === run) worktreeLocks.delete(name);
    });
  }

  const gitFailure = (err: unknown): HttpError =>
    err instanceof HttpError ? err : new HttpError(err instanceof GitError ? 409 : 500, err instanceof Error ? err.message : String(err));

  async function createWorktree(name: string, branch: string, opts: { fromCwd?: string } = {}): Promise<{ path: string; branch: string }> {
    const row = need(name);
    if (typeof branch !== "string" || !validBranchName(branch)) {
      throw new HttpError(400, `"${String(branch)}" isn't a valid branch name`);
    }
    if (row.missing === 1 || !isGitRepo(row.path)) throw new HttpError(409, `${row.path} is not a git repository`);
    try {
      await git(row.path, ["check-ref-format", "--branch", branch]);
    } catch {
      throw new HttpError(400, `"${branch}" isn't a valid branch name`);
    }
    const root = worktreeRoot(name);
    const rootReal = realPathLoose(root);

    return locked(name, async () => {
      try {
        const existing = parseWorktrees(await git(row.path, ["worktree", "list", "--porcelain"]));
        const mine = existing.find((w) => w.branch === branch);
        if (mine) {
          if (isInside(rootReal, realPathLoose(mine.path)) && existsSync(mine.path)) return { path: realPathLoose(mine.path), branch };
          throw new HttpError(409, `branch "${branch}" is already checked out at ${mine.path}`);
        }
        const path = freePath(root, branch);
        // `git worktree prune` first: a worktree directory deleted by hand would otherwise block its branch.
        await git(row.path, ["worktree", "prune"]).catch(() => {});

        if (await refExists(row.path, `refs/heads/${branch}`)) {
          await git(row.path, ["worktree", "add", path, branch]);
        } else {
          const def = settingsOf(row).defaultBranch;
          const remote = await baseRemote(row.path, def);
          // `fromCwd`: branch off that folder's HEAD commit (a fork continues where its parent is), when it has one.
          const head = opts.fromCwd && isAbsolute(opts.fromCwd) && existsSync(opts.fromCwd)
            ? (await git(opts.fromCwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).catch(() => "")).trim()
            : "";
          const base = head ? head : remote && (await refExists(row.path, `refs/remotes/${remote}/${def}`))
            ? `${remote}/${def}`
            : (await refExists(row.path, `refs/heads/${def}`))
              ? def
              : "HEAD";
          await git(row.path, ["worktree", "add", "--no-track", "-b", branch, path, base]);
        }
        return { path: realPathLoose(path), branch };
      } catch (err) {
        throw gitFailure(err);
      }
    });
  }

  /** <root>/<branch slug>; another branch with the same slug (a/b vs a-b) gets a hash of its name appended. */
  function freePath(root: string, branch: string): string {
    const slug = slugify(branch) || "branch";
    let path = join(root, slug);
    if (existsSync(path)) path = join(root, `${slug}-${createHash("sha1").update(branch).digest("hex").slice(0, 6)}`);
    if (existsSync(path)) throw new HttpError(409, `${path} already exists`);
    return path;
  }

  /** The local branch name `requested` stands for and, when it only exists on a remote, the remote ref to track. */
  async function resolveBranch(row: Row, requested: string): Promise<{ branch: string; upstream: string | null }> {
    if (typeof requested !== "string" || !validBranchName(requested)) throw new HttpError(400, `"${String(requested)}" isn't a valid branch name`);
    if (await refExists(row.path, `refs/heads/${requested}`)) return { branch: requested, upstream: null };
    // A remote one, as `<remote>/x` (any remote) or a bare `x` that the base (or another) remote has.
    let branch = requested;
    let upstream: string;
    const remotes = await listRemotes(row.path);
    const prefixed = remotes.find((r) => requested.startsWith(`${r}/`) && requested.length > r.length + 1);
    if (prefixed && (await refExists(row.path, `refs/remotes/${requested}`))) {
      branch = requested.slice(prefixed.length + 1);
      upstream = requested;
    } else {
      const base = await baseRemote(row.path, settingsOf(row).defaultBranch);
      let holder: string | undefined;
      for (const r of base ? [base, ...remotes.filter((x) => x !== base)] : remotes) {
        if (await refExists(row.path, `refs/remotes/${r}/${requested}`)) {
          holder = r;
          break;
        }
      }
      if (!holder) throw new HttpError(404, `no branch "${requested}" locally or on a remote`);
      upstream = `${holder}/${requested}`;
    }
    if (!validBranchName(branch)) throw new HttpError(400, `"${branch}" isn't a valid branch name`);
    // A local branch of the resulting name may exist even though the requested ref was remote-shaped.
    return { branch, upstream: (await refExists(row.path, `refs/heads/${branch}`)) ? null : upstream };
  }

  async function localBranchName(name: string, requested: string): Promise<string> {
    const row = need(name);
    if (row.missing === 1 || !isGitRepo(row.path)) throw new HttpError(409, `${row.path} is not a git repository`);
    try {
      return (await resolveBranch(row, requested)).branch;
    } catch (err) {
      throw gitFailure(err);
    }
  }

  async function openBranch(name: string, requested: string): Promise<{ path: string; branch: string }> {
    const row = need(name);
    if (typeof requested !== "string" || !validBranchName(requested)) throw new HttpError(400, `"${String(requested)}" isn't a valid branch name`);
    if (row.missing === 1 || !isGitRepo(row.path)) throw new HttpError(409, `${row.path} is not a git repository`);
    const root = worktreeRoot(name);
    return locked(name, async () => {
      try {
        await git(row.path, ["worktree", "prune"]).catch(() => {});
        const { branch, upstream } = await resolveBranch(row, requested);
        const existing = parseWorktrees(await git(row.path, ["worktree", "list", "--porcelain"]));
        const holder = existing.find((w) => w.branch === branch);
        if (holder) {
          if (resolve(holder.path) === resolve(row.path) || realPathLoose(holder.path) === realPathLoose(row.path)) {
            throw new HttpError(409, `branch "${branch}" is checked out in the project checkout`, "checked-out-elsewhere");
          }
          if (!existsSync(holder.path)) throw new HttpError(409, `branch "${branch}" is checked out at ${holder.path}, which is missing`, "checked-out-elsewhere");
          return { path: realPathLoose(holder.path), branch };
        }
        const path = freePath(root, branch);
        if (upstream) await git(row.path, ["worktree", "add", "--track", "-b", branch, path, upstream]);
        else await git(row.path, ["worktree", "add", path, branch]);
        return { path: realPathLoose(path), branch };
      } catch (err) {
        throw gitFailure(err);
      }
    });
  }

  async function existingWorktree(name: string, path: string): Promise<{ path: string; branch: string | null; main: boolean }> {
    const row = need(name);
    if (typeof path !== "string" || !isAbsolute(path)) throw new HttpError(400, "worktree path must be absolute");
    if (row.missing === 1 || !isGitRepo(row.path)) throw new HttpError(409, `${row.path} is not a git repository`);
    try {
      const target = realPathLoose(path);
      const list = await listWorktrees(row.path);
      const hit = list.find((w) => realPathLoose(w.path) === target);
      if (!hit || !existsSync(hit.path)) throw new HttpError(400, `${path} isn't a worktree of "${name}"`);
      return { path: target, branch: hit.branch, main: hit === list[0] };
    } catch (err) {
      throw gitFailure(err);
    }
  }

  async function worktrees(name: string): Promise<ProjectWorktrees> {
    const row = need(name);
    if (row.missing === 1 || !isGitRepo(row.path)) return { mainBranch: null, baseBranch: null, worktrees: [] };
    try {
      const list = await listWorktrees(row.path);
      const def = settingsOf(row).defaultBranch;
      const base = await defaultBase(row.path, def);
      const baseBranch = base ? def : null;
      const merged = base ? await mergedBranches(row.path, base) : new Set<string>();
      const sessionRows = db.prepare("SELECT id, title, state, cwd FROM sessions WHERE project = ? AND archived = 0 ORDER BY created_at DESC, id").all(name) as
        { id: string; title: string; state: ProjectWorktree["sessions"][number]["state"]; cwd: string }[];
      const byCwd = new Map<string, ProjectWorktree["sessions"]>();
      for (const s of sessionRows) {
        if (typeof s.cwd !== "string" || !isAbsolute(s.cwd)) continue;
        const key = realPathLoose(s.cwd);
        const bucket = byCwd.get(key) ?? [];
        bucket.push({ id: s.id, title: s.title, state: s.state, running: s.state === "running" || s.state === "waiting" });
        byCwd.set(key, bucket);
      }
      const out: ProjectWorktree[] = [];
      for (const [i, w] of list.entries()) {
        if (!existsSync(w.path)) continue; // deleted by hand: `git worktree prune` will drop it
        const real = realPathLoose(w.path);
        const [head, dirty, counts] = await Promise.all([
          git(w.path, ["rev-parse", "--verify", "--quiet", "HEAD"]).then((s) => s.trim() || null, () => null),
          statusPaths(w.path).then((p) => p.length > 0, () => false),
          base && w.branch ? aheadBehind(row.path, base, w.branch).catch(() => ({ ahead: 0, behind: 0 })) : Promise.resolve({ ahead: 0, behind: 0 }),
        ]);
        out.push({
          path: real,
          branch: w.branch,
          headSha: head,
          dirty,
          ahead: counts.ahead,
          behind: counts.behind,
          main: i === 0,
          merged: !!w.branch && w.branch !== baseBranch && merged.has(w.branch),
          sessions: (byCwd.get(real) ?? []).slice(0, 20),
        });
      }
      return { mainBranch: list[0]?.branch ?? null, baseBranch, worktrees: out };
    } catch (err) {
      throw gitFailure(err);
    }
  }

  async function removeWorktree(name: string, path: string): Promise<void> {
    const row = need(name);
    if (typeof path !== "string" || !isAbsolute(path)) throw new HttpError(400, "path must be absolute");
    const rootReal = realPathLoose(worktreeRoot(name));
    const target = realPathLoose(path);
    if (target === rootReal || !isInside(rootReal, target)) throw new HttpError(400, `${path} isn't a Odin worktree of "${name}"`);
    if (resolve(path) === resolve(row.path) || target === realPathLoose(row.path)) throw new HttpError(400, "the project checkout isn't a removable worktree");
    const live = db.prepare(`SELECT id, cwd FROM sessions WHERE state IN (${LIVE_STATES.map(() => "?").join(", ")})`).all(...LIVE_STATES) as { id: string; cwd: string }[];
    const holder = live.find((s) => typeof s.cwd === "string" && isAbsolute(s.cwd) && isInside(target, realPathLoose(s.cwd)));
    if (holder) throw new HttpError(409, `session ${holder.id} is working in ${path}; end it first`);
    const kernels = db.prepare("SELECT cwd FROM notebook_kernels WHERE state != 'stopped'").all() as { cwd: string }[];
    if (kernels.some(kernel => isAbsolute(kernel.cwd) && isInside(target, realPathLoose(kernel.cwd)))) throw new HttpError(409, "A notebook kernel uses this worktree; stop it first");
    return locked(name, async () => {
      try {
        if (!existsSync(path)) {
          await git(row.path, ["worktree", "prune"]);
          return;
        }
        if ((await statusPaths(path)).length) throw new HttpError(409, `${path} has uncommitted changes`);
        await git(row.path, ["worktree", "remove", path]);
      } catch (err) {
        throw gitFailure(err);
      }
    });
  }

  async function branches(name: string): Promise<ProjectBranch[]> {
    const row = need(name);
    if (row.missing === 1 || !isGitRepo(row.path)) return [];
    try {
      const [list, worktrees] = await Promise.all([listBranches(row.path), listWorktrees(row.path)]);
      const base = await defaultBase(row.path, settingsOf(row).defaultBranch);
      const merged = base ? await mergedBranches(row.path, base) : new Set<string>();
      const currentBranch = worktrees[0]?.branch ?? null;
      const sessionRows = db.prepare("SELECT id, branch, pull FROM sessions WHERE project = ? AND branch IS NOT NULL ORDER BY created_at DESC, id").all(name) as
        { id: string; branch: string; pull: string | null }[];
      const out: ProjectBranch[] = [];
      for (const b of list) {
        const counts = base ? await aheadBehind(row.path, base, b.name).catch(() => ({ ahead: 0, behind: 0 })) : { ahead: 0, behind: 0 };
        const wt = worktrees.find((w) => w.branch === b.name);
        const mine = sessionRows.filter((s) => s.branch === b.name);
        out.push({
          name: b.name,
          headSha: b.headSha,
          ahead: counts.ahead,
          behind: counts.behind,
          merged: merged.has(b.name),
          lastCommitAt: b.lastCommitAt,
          worktreePath: wt ? wt.path : null,
          current: b.name === currentBranch,
          sessionIds: mine.map((s) => s.id),
          pull: pullFor(name, b.name, mine.map((s) => s.pull)),
        });
      }
      return out;
    } catch (err) {
      throw gitFailure(err);
    }
  }

  /** The stored PR whose head is this branch (sync), else the newest pull a session on it recorded. */
  function pullFor(name: string, branch: string, sessionPulls: (string | null)[]): PullRef | null {
    try {
      const p = services?.sync?.pullForBranch(name, branch);
      if (p) return { number: p.number, url: p.url, state: p.state, merged: p.merged };
    } catch {
      // sync unavailable: fall back to the sessions' records
    }
    for (const raw of sessionPulls) {
      if (!raw) continue;
      try {
        const p = JSON.parse(raw) as PullRef | null;
        if (p && typeof p.number === "number") return { number: p.number, url: p.url, state: p.state, merged: !!p.merged };
      } catch {
        // skip a bad record
      }
    }
    return null;
  }

  // ── create ────────────────────────────────────────────────────────────────

  /** `owner/name` → GitHub https URL; https://, ssh:// and git@host:path pass; anything else (ext::, file, -options) is refused. */
  function cloneUrlOf(input: unknown): string {
    if (typeof input !== "string" || !input.trim()) throw new HttpError(400, "clone must be a repository URL or owner/name");
    const v = input.trim();
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return `https://github.com/${v.replace(/\.git$/, "")}.git`;
    if (/^(https:\/\/|ssh:\/\/)[^\s]+$/.test(v) || /^git@[A-Za-z0-9.-]+:[^\s]+$/.test(v)) return v;
    throw new HttpError(400, "clone must be owner/name, an https:// or ssh:// URL, or git@host:path");
  }

  async function create(req: CreateProjectRequest): Promise<ProjectRef> {
    if (req === null || typeof req !== "object") throw new HttpError(400, "expected a JSON object");
    if (typeof req.path !== "string" || !req.path.trim()) throw new HttpError(400, "path is required");
    const expanded = expandHome(req.path.trim());
    if (!isAbsolute(expanded)) throw new HttpError(400, "path must be absolute");
    const path = resolve(expanded);
    if (req.name !== undefined && (typeof req.name !== "string" || !PROJECT_NAME_PATTERN.test(req.name))) {
      throw new HttpError(400, `"${String(req.name)}" isn't a valid project name (a-z, 0-9 and -, up to 40)`);
    }
    const makes = req.mkdir === true || req.clone !== undefined;
    if (req.clone !== undefined && (req.mkdir || req.init || req.readme)) throw new HttpError(400, "clone can't be combined with mkdir, init or readme");
    if (req.readme && !req.mkdir) throw new HttpError(400, "readme needs mkdir");
    const cloneUrl = req.clone === undefined ? null : cloneUrlOf(req.clone);
    if (makes) {
      if (existsSync(path) && !(statSync(path).isDirectory() && readdirSync(path).length === 0)) {
        throw new HttpError(409, `${path} already exists and isn't an empty folder`);
      }
    } else if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, `${path} isn't a folder`);
    const name = req.name ?? slugify(basename(path));
    if (!PROJECT_NAME_PATTERN.test(name)) throw new HttpError(400, `"${name}" isn't a valid project name (a-z, 0-9 and -, up to 40); pass name`);
    if (getRow(name)) throw new HttpError(409, `a project named "${name}" is already registered`);
    const real = realPathLoose(path);
    for (const row of allRows()) {
      if (row.path === path || realPathLoose(row.path) === real) throw new HttpError(409, `${path} is already registered as "${row.name}"`);
    }
    // Everything is validated; from here on a failure removes the folder this call made.
    const existedBefore = existsSync(path);
    try {
      if (makes) mkdirSync(existedBefore ? path : dirname(path), { recursive: true });
      if (cloneUrl !== null) {
        try {
          await cloneRepo(dirname(path), cloneUrl, path);
        } catch (err) {
          throw new HttpError(400, `couldn't clone: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (makes) {
        mkdirSync(path, { recursive: true });
        if (req.readme) writeFileSync(join(path, "README.md"), `# ${name}\n`, { flag: "wx" });
      }
      if (!isGitRepo(path) && req.init === true) {
        try {
          await initRepo(path, "main");
        } catch (err) {
          throw new HttpError(500, `git init failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      if (makes && !existedBefore) rmSync(path, { recursive: true, force: true });
      throw err;
    }
    const t = now();
    db.prepare("INSERT INTO projects (name, path, created_at, updated_at) VALUES (?, ?, ?, ?)").run(name, path, t, t);
    await refresh(name);
    bus.emit({ type: "project.updated", project: name });
    return toRef(need(name));
  }

  // ── the service ───────────────────────────────────────────────────────────

  return {
    list: () => allRows().map(toRef),
    get(name) {
      const row = getRow(name);
      return row ? toRef(row) : null;
    },

    detail(name) {
      const row = getRow(name);
      if (!row) return null;
      const view = viewOf(row);
      return {
        name: row.name,
        title: view.settings.title,
        description: view.settings.description,
        path: row.path,
        repo: view.settings.repo,
        missing: row.missing === 1,
        updatedAt: row.updated_at,
        settings: view.settings,
        manifestError: row.manifest_error,
        git: JSON.parse(row.git),
        status: view.status,
        agents: agentsOf(row),
        dirtyFiles: JSON.parse(row.written_files),
        context: view.context,
      };
    },

    resolveCwd(cwd) {
      if (typeof cwd !== "string" || !cwd || !isAbsolute(cwd)) return null;
      const target = realPathLoose(cwd);
      let best: { name: string; len: number } | null = null;
      for (const row of allRows()) {
        const root = realPathLoose(row.path);
        if (isInside(root, target) && (!best || root.length > best.len)) best = { name: row.name, len: root.length };
        const wt = realPathLoose(worktreeRoot(row.name));
        if (isInside(wt, target) && (!best || wt.length > best.len)) best = { name: row.name, len: wt.length };
        // Worktrees made elsewhere: each is recorded as <repo>/.git/worktrees/<id>/gitdir -> <worktree>/.git.
        for (const folder of linkedWorktreeFolders(row.path)) {
          const real = realPathLoose(folder);
          if (isInside(real, target) && (!best || real.length > best.len)) best = { name: row.name, len: real.length };
        }
      }
      return best?.name ?? null;
    },

    create,

    async updateSettings(name, req) {
      const row = need(name);
      const { set, clear } = checkOverrides(req);
      const overrides = JSON.parse(row.settings) as Record<string, unknown>;
      for (const key of clear) delete overrides[key];
      Object.assign(overrides, set);
      db.prepare("UPDATE projects SET settings = ?, updated_at = ? WHERE name = ?").run(JSON.stringify(overrides), now(), name);
      // A new default branch changes ahead/behind; refresh re-reads it.
      await refresh(name);
      bus.emit({ type: "project.updated", project: name });
      return toRef(need(name));
    },

    async updateSources(name, req: UpdateProjectSourcesRequest) {
      need(name);
      if (req === null) {
        db.prepare("UPDATE projects SET sources = NULL, updated_at = ? WHERE name = ?").run(now(), name);
      } else {
        const parsed = parseProjectSources(req);
        if (!parsed.ok) throw new HttpError(400, parsed.error);
        db.prepare("UPDATE projects SET sources = ?, updated_at = ? WHERE name = ?").run(JSON.stringify(parsed.selection), now(), name);
      }
      bus.emit({ type: "project.updated", project: name });
      return toRef(need(name));
    },

    refresh,

    remove(name) {
      if (db.prepare("SELECT 1 FROM notebook_kernels WHERE project = ? LIMIT 1").get(name))
        throw new HttpError(409, "This project has notebooks. Remove its notebook kernels before removing the project.");
      if (db.prepare("SELECT 1 FROM sessions WHERE project = ? OR EXISTS (SELECT 1 FROM json_each(sessions.projects) WHERE value = ?) LIMIT 1").get(name, name))
        throw new HttpError(409, "This project is configured in sessions. Remove those sessions before removing the project.");
      need(name);
      db.prepare("DELETE FROM projects WHERE name = ?").run(name);
      bus.emit({ type: "project.removed", project: name });
    },

    agents(name) {
      const row = getRow(name);
      return row ? agentsOf(row) : [];
    },

    createWorktree,
    openBranch,
    localBranchName,
    existingWorktree,
    worktrees,
    removeWorktree,
    branches,

    noteWritten(name, paths) {
      const row = getRow(name);
      if (!row) return;
      const have = JSON.parse(row.written_files) as string[];
      const clean = paths.filter((p) => typeof p === "string" && p && !isAbsolute(p) && !p.split(/[\\/]/).includes(".."));
      const next = [...new Set([...have, ...clean.map((p) => p.split(sep).join("/"))])];
      if (next.length !== have.length) db.prepare("UPDATE projects SET written_files = ? WHERE name = ?").run(JSON.stringify(next), name);
      void refresh(name).catch(() => {});
    },

    async close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.allSettled([...inflight.values()].map(entry => entry.promise));
      await Promise.allSettled([...worktreeLocks.values()]);
    },
  };
}
