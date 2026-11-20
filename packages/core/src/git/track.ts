// Keeps git facts fresh: fans `git.changed` out to every target sharing a checkout, re-reads that checkout's
// branch into the live sessions working there, and watches those checkouts so changes made outside Odin (an agent's
// Bash, a terminal) are noticed. A session folder inside a repo counts as that repo. Registered projects are watched
// even with no live session, and a session's other repositories are watched with it. Watchers are reference-counted
// per checkout and every failure is ignored.
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Session } from "@odin/shared/api";
import { isFinal } from "@odin/shared/session";
import type { GitTarget } from "@odin/shared/git";
import type { Deps, Services } from "../services.ts";
import { runGit } from "./run.ts";

export interface GitTracker {
  /** Announces a change in `cwd` to the project and every live session there, and refreshes their branch. */
  changed(cwd: string, also?: GitTarget): Promise<void>;
  /** Reads `cwd`'s branch into the live sessions working in that checkout when it differs from the stored one. */
  refreshBranch(cwd: string): Promise<void>;
  /** Watches `cwd`'s checkout until the returned release is called (counted: one watcher set per checkout). */
  watch(cwd: string): () => void;
  /** Starts following sessions and registered projects. */
  start(): void;
  close(): void;
}

export interface TrackerOptions {
  debounceMs?: number;
  /** Injectable for tests; defaults to fs.watch. */
  watchFn?: (path: string, recursive: boolean, onEvent: (file: string | null) => void) => { close(): void };
  /** false: no watchers and no session subscription (start() does nothing). */
  watching?: boolean;
}

export function normalPath(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

const roots = new Map<string, string | null>();

/** The checkout that contains `cwd` (the directory with `.git`, walked upward). Null when there is none. */
export function checkoutRoot(cwd: string): string | null {
  const start = resolve(cwd);
  const key = normalPath(start);
  const cached = roots.get(key);
  if (cached !== undefined) return cached !== null && existsSync(join(cached, ".git")) ? cached : cached === null ? null : find(start);
  return find(start);

  function find(from: string): string | null {
    let dir = from;
    for (;;) {
      if (existsSync(join(dir, ".git"))) {
        roots.set(key, dir);
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) {
        roots.set(key, null);
        return null;
      }
      dir = parent;
    }
  }
}

const HEAD_FILES = new Set(["HEAD", "index", "packed-refs", "MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]);

function defaultWatch(path: string, recursive: boolean, onEvent: (file: string | null) => void): FSWatcher {
  const w = watch(path, { recursive, persistent: false }, (_t, file) => onEvent(file ? String(file) : null));
  w.on("error", () => {});
  return w;
}

/** The git directory of a worktree and the common one holding refs (the same for a main checkout). */
function gitDirs(cwd: string): { gitDir: string; common: string } | null {
  try {
    const dot = join(cwd, ".git");
    if (statSync(dot).isDirectory()) return { gitDir: dot, common: dot };
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
    if (!m) return null;
    const raw = m[1]!.trim();
    const gitDir = isAbsolute(raw) ? raw : resolve(cwd, raw);
    let common = gitDir;
    try {
      const c = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      if (c) common = isAbsolute(c) ? c : resolve(gitDir, c);
    } catch { /* no commondir */ }
    return { gitDir, common };
  } catch {
    return null;
  }
}

interface Folder {
  cwd: string;
  count: number;
  closers: { close(): void }[];
  timer: NodeJS.Timeout | null;
}

export function createGitTracker(deps: Deps, services: Services, opts: TrackerOptions = {}): GitTracker {
  const debounceMs = opts.debounceMs ?? 300;
  const watchFn = opts.watchFn ?? defaultWatch;
  const enabled = opts.watching !== false;
  const folders = new Map<string, Folder>();
  const live = new Map<string, string>(); // session id -> signature of the checkouts it watches
  const releases = new Map<string, () => void>();
  const projectHolds = new Map<string, { key: string; release: () => void }>();
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  function locate(cwd: string): string {
    return checkoutRoot(cwd) ?? resolve(cwd);
  }

  /** undefined: not a repo or unreadable (leave the stored branch alone). null: detached. */
  async function readBranch(cwd: string): Promise<string | null | undefined> {
    const root = checkoutRoot(cwd);
    if (!root) return undefined;
    try {
      const r = await runGit(root, ["symbolic-ref", "--short", "-q", "HEAD"], { ok: [0, 1] });
      return r.code === 0 ? r.stdout.trim() || null : null;
    } catch {
      return undefined;
    }
  }

  /** Checkouts other than the one the session is working in. */
  function extraRoots(s: Session): string[] {
    const work = normalPath(locate(s.cwd));
    const found: string[] = [];
    for (const name of s.projects ?? []) {
      if (name === s.project) continue;
      let path: string | null = null;
      try { path = services.projects.get(name)?.path ?? null; } catch { path = null; }
      if (!path) continue;
      const root = locate(path);
      const key = normalPath(root);
      if (key === work || found.some((r) => normalPath(r) === key)) continue;
      found.push(root);
    }
    return found;
  }

  function workKey(s: Session): string {
    return normalPath(locate(s.cwd));
  }

  function interested(s: Session, key: string): boolean {
    if (isFinal(s.state)) return false;
    if (workKey(s) === key) return true;
    return extraRoots(s).some((root) => normalPath(root) === key);
  }

  async function refreshBranch(cwd: string): Promise<void> {
    const root = checkoutRoot(cwd);
    if (!root) return;
    const key = normalPath(root);
    const here = services.sessions.list().filter((s) => !isFinal(s.state) && workKey(s) === key);
    if (!here.length) return;
    const branch = await readBranch(root);
    if (branch === undefined) return;
    for (const s of here) {
      const cur = services.sessions.get(s.id);
      if (!cur || isFinal(cur.state) || cur.branch === branch) continue;
      try { services.sessions.patch(s.id, { branch }); } catch { /* removed meanwhile */ }
    }
  }

  function announce(cwd: string, also?: GitTarget): void {
    const seen = new Set<string>();
    const emit = (kind: GitTarget["kind"], id: string) => {
      if (seen.has(`${kind}:${id}`)) return;
      seen.add(`${kind}:${id}`);
      deps.bus.emit({ type: "git.changed", target: { kind, id } });
    };
    if (also) emit(also.kind, also.id);
    const key = normalPath(locate(cwd));
    try {
      for (const p of services.projects.list()) {
        if (normalPath(locate(p.path)) === key) emit("project", p.name);
      }
      for (const s of services.sessions.list()) {
        if (interested(s, key)) emit("session", s.id);
      }
    } catch { /* the target alone was announced */ }
  }

  async function changed(cwd: string, also?: GitTarget): Promise<void> {
    try { await refreshBranch(cwd); } catch { /* best effort */ }
    announce(cwd, also);
  }

  function watchFolder(cwd: string): () => void {
    if (!enabled || closed) return () => {};
    const root = locate(cwd);
    const key = normalPath(root);
    let f = folders.get(key);
    if (!f) {
      const folder: Folder = { cwd: root, count: 0, closers: [], timer: null };
      f = folder;
      folders.set(key, folder);
      const dirs = gitDirs(root);
      const fire = () => {
        if (closed || folders.get(key) !== folder) return;
        if (folder.timer) clearTimeout(folder.timer);
        folder.timer = setTimeout(() => { folder.timer = null; void changed(root).catch(() => {}); }, debounceMs);
        folder.timer.unref?.();
      };
      if (dirs) {
        const add = (path: string, recursive: boolean, accept: (file: string | null) => boolean) => {
          try { folder.closers.push(watchFn(path, recursive, (file) => { if (accept(file)) fire(); })); } catch { /* unwatchable: ignore */ }
        };
        add(dirs.gitDir, false, (file) => file === null || HEAD_FILES.has(file));
        add(join(dirs.common, "refs"), true, (file) => file === null || !file.endsWith(".lock"));
        if (dirs.common !== dirs.gitDir) add(dirs.common, false, (file) => file === "packed-refs");
      }
    }
    f.count++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const cur = folders.get(key);
      if (!cur || --cur.count > 0) return;
      if (cur.timer) clearTimeout(cur.timer);
      for (const c of cur.closers) { try { c.close(); } catch { /* ignore */ } }
      folders.delete(key);
    };
  }

  function track(s: Session): void {
    if (isFinal(s.state)) {
      if (live.has(s.id)) { releases.get(s.id)?.(); releases.delete(s.id); live.delete(s.id); }
      return;
    }
    const watched = [locate(s.cwd), ...extraRoots(s)];
    const sig = watched.map((root) => normalPath(root)).join("\0");
    if (live.get(s.id) === sig) return;
    releases.get(s.id)?.();
    const held = watched.map((root) => watchFolder(root));
    releases.set(s.id, () => { for (const release of held) release(); });
    live.set(s.id, sig);
  }

  function syncProjects(): void {
    let list: { name: string; path: string }[] = [];
    try { list = services.projects.list(); } catch { return; }
    const names = new Set(list.map((p) => p.name));
    for (const [name, held] of projectHolds) {
      if (names.has(name)) continue;
      held.release();
      projectHolds.delete(name);
    }
    for (const project of list) {
      const root = locate(project.path);
      const key = normalPath(root);
      const prev = projectHolds.get(project.name);
      if (prev?.key === key) continue;
      prev?.release();
      projectHolds.set(project.name, { key, release: watchFolder(root) });
    }
  }

  return {
    changed,
    refreshBranch,
    watch: watchFolder,
    start() {
      if (!enabled || unsubscribe) return;
      const lastState = new Map<string, string>();
      for (const s of services.sessions.list()) { track(s); lastState.set(s.id, s.state); }
      syncProjects();
      const stopSessions = services.sessions.onUpdated((s) => {
        track(s);
        const prev = lastState.get(s.id);
        lastState.set(s.id, s.state);
        // A turn just ended: the agent may have switched branches.
        if (s.state === "idle" && prev !== "idle") void refreshBranch(s.cwd).catch(() => {});
      });
      const stopProjects = deps.bus.subscribe((event) => {
        if (event.type === "project.updated" || event.type === "project.removed") syncProjects();
      });
      unsubscribe = () => { stopSessions(); stopProjects(); };
    },
    close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const held of projectHolds.values()) held.release();
      projectHolds.clear();
      for (const release of releases.values()) release();
      releases.clear();
      live.clear();
      for (const f of folders.values()) {
        if (f.timer) clearTimeout(f.timer);
        for (const c of f.closers) { try { c.close(); } catch { /* ignore */ } }
      }
      folders.clear();
    },
  };
}
