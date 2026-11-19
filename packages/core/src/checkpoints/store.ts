// The shadow git store behind session checkpoints (docs/contracts.md#checkpoints). One bare repository per project under
// <home>/checkpoints/, driven as `git --git-dir=<store> --work-tree=<cwd>` with argv (never a shell string). The user's own
// .git, index, refs and hooks are never touched. Snapshots are trees; each tree is kept alive by a ref
// `refs/odin/t/<tree>` pointing at a commit that holds it.
import { execFile } from "node:child_process";
import { mkdirSync, existsSync, statSync, rmSync, unlinkSync, rmdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { gitBinary } from "../tools/resolve.ts";
import type { CheckpointFileChange } from "@odin/shared/api";

export const MAX_FILES = 20_000;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const SNAPSHOT_TIMEOUT_MS = 10_000;
const DIFF_PATH_CAP = 500;

/** `skipped`: over the budget or not a directory. Otherwise a failure (`failed`). */
export type Snapshot = { ok: true; tree: string; files: number } | { ok: false; reason: string; skipped: boolean };

interface GitOptions {
  env?: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  cwd?: string;
}

function run(args: string[], options: GitOptions = {}): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      gitBinary(),
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", ...options.env },
      },
      (err, stdout, stderr) => {
        if (!err) return resolvePromise(String(stdout));
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        const why = e.killed ? `timed out after ${options.timeoutMs ?? 30_000}ms` : String(stderr).trim().split("\n")[0] || e.message;
        reject(new Error(`git ${args.find((a) => !a.startsWith("-") && !a.includes("=")) ?? ""}: ${why}`));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

/** Runs async jobs one at a time per key, so two sessions in one project never fight over the store's index. */
class KeyedQueue {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(job, job);
    const tail = next.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => { if (this.tails.get(key) === tail) this.tails.delete(key); });
    return next;
  }
}

export class CheckpointStore {
  readonly root: string;
  readonly project: string;
  readonly gitDir: string;
  private readonly queue = new KeyedQueue();
  private ready: Promise<void> | null = null;

  constructor(root: string, project: string) {
    this.root = root;
    this.project = project;
    this.gitDir = join(root, `${safeName(project)}.git`);
  }

  private base(cwd: string | null): string[] {
    return ["--git-dir", this.gitDir, ...(cwd ? ["--work-tree", cwd] : [])];
  }

  private env(index: string): Record<string, string> {
    return {
      GIT_INDEX_FILE: join(this.gitDir, index),
      GIT_AUTHOR_NAME: "Odin", GIT_AUTHOR_EMAIL: "odin@localhost", GIT_COMMITTER_NAME: "Odin", GIT_COMMITTER_EMAIL: "odin@localhost",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      if (!existsSync(join(this.gitDir, "HEAD"))) {
        mkdirSync(dirname(this.gitDir), { recursive: true });
        await run(["init", "--bare", "--quiet", this.gitDir]);
      }
      for (const [k, v] of [["core.bare", "false"], ["core.autocrlf", "false"], ["core.safecrlf", "false"], ["core.longpaths", "true"], ["core.quotepath", "off"], ["core.fsmonitor", "false"], ["gc.auto", "0"], ["core.hooksPath", join(this.gitDir, "no-hooks")]] as const) {
        await run(["--git-dir", this.gitDir, "config", k, v]);
      }
    })().catch((err) => { this.ready = null; throw err; });
    return this.ready;
  }

  /** Snapshots `cwd` (honouring its .gitignore files) and returns the tree id, or why it was skipped. */
  snapshot(cwd: string): Promise<Snapshot> {
    return this.queue.run(this.project, async () => {
      let isDir = false;
      try { isDir = statSync(cwd).isDirectory(); } catch { /* missing */ }
      if (!isDir) return { ok: false, reason: "the working directory is not a directory", skipped: true } as const;
      try {
        await this.init();
        const env = this.env("index-snap");
        const started = Date.now();
        await run([...this.base(cwd), "add", "-A", "--ignore-errors", "--", "."], { env, cwd, timeoutMs: SNAPSHOT_TIMEOUT_MS });
        let tree = (await run([...this.base(cwd), "write-tree"], { env, cwd })).trim();
        const listing = await run([...this.base(null), "ls-tree", "-r", "-l", "-z", tree], { env });
        const entries = listing.split("\0").filter(Boolean);
        if (entries.length > MAX_FILES) return { ok: false, reason: `more than ${MAX_FILES} files`, skipped: true } as const;
        if (Date.now() - started > SNAPSHOT_TIMEOUT_MS) return { ok: false, reason: "the snapshot took too long", skipped: true } as const;
        const big: string[] = [];
        for (const entry of entries) {
          const tab = entry.indexOf("\t");
          const [, type, , size] = entry.slice(0, tab).split(/\s+/);
          if (type === "blob" && Number(size) > MAX_FILE_BYTES) big.push(entry.slice(tab + 1));
        }
        if (big.length) {
          await run([...this.base(cwd), "update-index", "--force-remove", "-z", "--stdin"], { env, cwd, input: big.join("\0") + "\0" });
          tree = (await run([...this.base(cwd), "write-tree"], { env, cwd })).trim();
        }
        await this.keep(tree);
        return { ok: true, tree, files: entries.length - big.length } as const;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason, skipped: /timed out/.test(reason) } as const;
      }
    });
  }

  /** Makes sure a ref holds `tree` alive. */
  private async keep(tree: string): Promise<void> {
    const ref = `refs/odin/t/${tree}`;
    try { await run([...this.base(null), "rev-parse", "--verify", "--quiet", ref]); return; } catch { /* missing */ }
    const commit = (await run([...this.base(null), "commit-tree", "-m", "odin checkpoint", tree], { env: this.env("index-snap") })).trim();
    await run([...this.base(null), "update-ref", ref, commit]);
  }

  /** Files that differ between two trees (`from` null means "nothing"). Paths are relative with `/` separators. */
  diff(from: string | null, to: string): Promise<{ files: CheckpointFileChange[]; truncated: boolean; all: CheckpointFileChange[] }> {
    return this.queue.run(this.project, async () => {
      await this.init();
      const args = from === null
        ? [...this.base(null), "ls-tree", "-r", "--name-only", "-z", to]
        : [...this.base(null), "diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to];
      const out = (await run(args)).split("\0").filter(Boolean);
      const all: CheckpointFileChange[] = [];
      if (from === null) for (const path of out) all.push({ path, status: "added" });
      else for (let i = 0; i + 1 < out.length; i += 2) {
        const s = out[i]!;
        all.push({ path: out[i + 1]!, status: s === "A" ? "added" : s === "D" ? "removed" : "modified" });
      }
      all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { files: all.slice(0, DIFF_PATH_CAP), truncated: all.length > DIFF_PATH_CAP, all };
    });
  }

  /**
   * Makes `cwd` match `target`: writes files that are added or modified relative to `current`, and deletes the ones
   * `current` had that `target` lacks. Files in neither tree (untracked-and-ignored, over the size cap) are never touched.
   */
  restore(cwd: string, current: string, target: string): Promise<void> {
    return this.queue.run(this.project, async () => {
      await this.init();
      const { all } = await this.diffUnlocked(current, target);
      const write = all.filter((c) => c.status !== "removed").map((c) => c.path);
      const remove = all.filter((c) => c.status === "removed").map((c) => c.path);
      const root = resolve(cwd);
      const inside = (p: string) => { const full = resolve(root, p); return full === root || full.startsWith(root + sep) ? full : null; };
      if (write.length) {
        const env = this.env("index-restore");
        await run([...this.base(null), "read-tree", target], { env });
        await run([...this.base(cwd), "checkout-index", "-f", "-q", "-z", "--stdin"], { env, cwd, input: write.join("\0") + "\0" });
      }
      for (const path of remove) {
        const full = inside(path);
        if (!full) continue;
        try { unlinkSync(full); } catch { continue; }
        for (let dir = dirname(full); dir !== root && dir.startsWith(root + sep); dir = dirname(dir)) {
          try { rmdirSync(dir); } catch { break; }
        }
      }
    });
  }

  /** Writes every file of `tree` into `dir` and deletes the tracked files of `dir` that `tree` lacks (a fresh worktree). */
  async materialize(dir: string, tree: string): Promise<void> {
    await this.queue.run(this.project, async () => {
      await this.init();
      const root = resolve(dir);
      const env = this.env("index-restore");
      await run([...this.base(null), "read-tree", tree], { env });
      await run([...this.base(dir), "checkout-index", "-a", "-f", "-q"], { env, cwd: dir });
      const wanted = new Set((await run([...this.base(null), "ls-tree", "-r", "--name-only", "-z", tree])).split("\0").filter(Boolean));
      // A fresh worktree is a git checkout; anything else has no tracked files to clean up.
      const present = (await run(["-C", dir, "ls-files", "-z"]).catch(() => "")).split("\0").filter(Boolean);
      for (const path of present) {
        if (wanted.has(path)) continue;
        const full = resolve(root, path);
        if (!full.startsWith(root + sep)) continue;
        try { unlinkSync(full); } catch { /* already gone */ }
      }
    });
  }

  private async diffUnlocked(from: string, to: string): Promise<{ all: CheckpointFileChange[] }> {
    const out = (await run([...this.base(null), "diff-tree", "-r", "--no-renames", "--name-status", "-z", from, to])).split("\0").filter(Boolean);
    const all: CheckpointFileChange[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const s = out[i]!;
      all.push({ path: out[i + 1]!, status: s === "A" ? "added" : s === "D" ? "removed" : "modified" });
    }
    return { all };
  }

  /** Drops the refs of trees nobody references any more, then prunes unreachable objects. */
  async release(trees: string[], pruneNow: boolean): Promise<void> {
    if (!existsSync(this.gitDir)) return;
    await this.queue.run(this.project, async () => {
      for (const tree of trees) {
        try { await run([...this.base(null), "update-ref", "-d", `refs/odin/t/${tree}`]); } catch { /* already gone */ }
      }
      if (pruneNow && trees.length) {
        try { await run([...this.base(null), "gc", "--prune=now", "--quiet"], { timeoutMs: 120_000 }); } catch { /* best effort */ }
      }
    });
  }

  /** Approximate size of the store in bytes. */
  async bytes(): Promise<number> {
    if (!existsSync(this.gitDir)) return 0;
    try {
      const out = await run([...this.base(null), "count-objects", "-v"]);
      let kib = 0;
      for (const line of out.split("\n")) {
        const m = /^(size|size-pack):\s*(\d+)/.exec(line);
        if (m) kib += Number(m[2]);
      }
      return kib * 1024;
    } catch { return 0; }
  }

  destroy(): void {
    rmSync(this.gitDir, { recursive: true, force: true });
  }
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "_") || "project";
}
