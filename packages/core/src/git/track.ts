// Keeps git facts fresh: fans `git.changed` out to every target sharing a folder, re-reads a folder's branch into the
// sessions stored there, and watches the folders of live sessions so changes made outside Odin (an agent's Bash, a
// terminal) are noticed. Watchers are reference-counted per folder and every failure is ignored.
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { SessionState } from "@odin/shared/api";
import { isFinal } from "@odin/shared/session";
import type { GitTarget } from "@odin/shared/git";
import type { Deps, Services } from "../services.ts";
import { runGit } from "./run.ts";

export interface GitTracker {
  /** Announces a change in `cwd` to the project and every live session there, and refreshes their branch. */
  changed(cwd: string, also?: GitTarget): Promise<void>;
  /** Reads `cwd`'s branch into the live sessions there when it differs from the stored one. */
  refreshBranch(cwd: string): Promise<void>;
  /** Watches `cwd` until the returned release is called (counted: one watcher set per folder). */
  watch(cwd: string): () => void;
  /** Starts following sessions: watches live ones' folders and refreshes the branch when a turn ends. */
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
  const live = new Map<string, string>(); // session id -> normalised cwd it is watched under
  const releases = new Map<string, () => void>();
  let unsubscribe: (() => void) | null = null;
  let closed = false;

  /** undefined: not a repo or unreadable (leave the stored branch alone). null: detached. */
  async function readBranch(cwd: string): Promise<string | null | undefined> {
    if (!existsSync(join(cwd, ".git"))) return undefined;
    try {
      const r = await runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], { ok: [0, 1] });
      return r.code === 0 ? r.stdout.trim() || null : null;
    } catch {
      return undefined;
    }
  }

  async function refreshBranch(cwd: string): Promise<void> {
    const key = normalPath(cwd);
    const here = services.sessions.list().filter((s) => normalPath(s.cwd) === key && !isFinal(s.state));
    if (!here.length) return;
    const branch = await readBranch(cwd);
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
    const key = normalPath(cwd);
    try {
      for (const p of services.projects.list()) {
        if (normalPath(p.path) === key) emit("project", p.name);
      }
      for (const s of services.sessions.list()) {
        if (!isFinal(s.state) && normalPath(s.cwd) === key) emit("session", s.id);
      }
    } catch { /* the target alone was announced */ }
  }

  async function changed(cwd: string, also?: GitTarget): Promise<void> {
    try { await refreshBranch(cwd); } catch { /* best effort */ }
    announce(cwd, also);
  }

  function watchFolder(cwd: string): () => void {
    if (!enabled || closed) return () => {};
    const key = normalPath(cwd);
    let f = folders.get(key);
    if (!f) {
      const folder: Folder = { cwd, count: 0, closers: [], timer: null };
      f = folder;
      folders.set(key, folder);
      const dirs = gitDirs(cwd);
      const fire = () => {
        if (closed || folders.get(key) !== folder) return;
        if (folder.timer) clearTimeout(folder.timer);
        folder.timer = setTimeout(() => { folder.timer = null; void changed(cwd).catch(() => {}); }, debounceMs);
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

  function track(id: string, cwd: string, state: SessionState): void {
    const key = normalPath(cwd);
    const had = live.get(id);
    if (isFinal(state)) {
      if (had !== undefined) { releases.get(id)?.(); releases.delete(id); live.delete(id); }
      return;
    }
    if (had === key) return;
    releases.get(id)?.();
    releases.set(id, watchFolder(cwd));
    live.set(id, key);
  }

  return {
    changed,
    refreshBranch,
    watch: watchFolder,
    start() {
      if (!enabled || unsubscribe) return;
      const lastState = new Map<string, string>();
      for (const s of services.sessions.list()) { track(s.id, s.cwd, s.state); lastState.set(s.id, s.state); }
      unsubscribe = services.sessions.onUpdated((s) => {
        track(s.id, s.cwd, s.state);
        const prev = lastState.get(s.id);
        lastState.set(s.id, s.state);
        // A turn just ended: the agent may have switched branches.
        if (s.state === "idle" && prev !== "idle") void refreshBranch(s.cwd).catch(() => {});
      });
    },
    close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const f of folders.values()) {
        if (f.timer) clearTimeout(f.timer);
        for (const c of f.closers) { try { c.close(); } catch { /* ignore */ } }
      }
      folders.clear();
      releases.clear();
      live.clear();
    },
  };
}
