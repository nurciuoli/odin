// GitService: the working tree, index, branches, stashes and history of a session's worktree or a project's folder,
// through the git CLI. docs/contracts.md#git. Writes are queued per checkout; every write emits `git.changed`.
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  GitBlame, GitBranches, GitChange, GitCheckoutRequest, GitCheckoutResult, GitCommitDetail, GitCommitRequest, GitCommitResult,
  GitAction, GitActionRun, GitFileDiff, GitLog, GitPatchRequest, GitPullRequest, GitPushRequest, GitStash, GitStashRequest, GitStatus, GitSyncResult, GitTarget,
} from "@odin/shared/git";
import { AUTO_STASH_PREFIX } from "@odin/shared/git";
import { validBranchName } from "../git-policy.ts";
import { HttpError } from "../http/util.ts";
import { parseWorktreeList } from "../projects/git.ts";
import type { Deps, GitService, Services } from "../services.ts";
import {
  addedFileDiff, BRANCH_FORMAT, hunkPatch, LOG_FORMAT, parseBlamePorcelain, parseBranches, parseDiff, parseLog, parseNumstatZ,
  parseStashes, parseStatusV2, publicDiff, STASH_FORMAT, trailers, ZERO_SHA, type RawFileDiff,
} from "./parse.ts";
import { classify, gitConflict, gitOut, NETWORK_TIMEOUT_MS, runGit } from "./run.ts";
import { loadActions, runAction, runTrigger } from "./actions.ts";

const MAX_UNTRACKED_BYTES = 1024 * 1024;
const LOG_LIMIT_MAX = 200;

/** A repo-relative path from the client: no absolute paths, no `..`, nothing that git could read as an option. */
export function cleanRelPath(p: unknown): string {
  if (typeof p !== "string" || !p || p.length > 4096) throw new HttpError(400, "path required");
  const norm = p.replace(/\\/g, "/");
  if (isAbsolute(p) || norm.startsWith("/") || norm.split("/").some(s => s === ".." ) || norm.startsWith("-") || norm.includes("\0")) {
    throw new HttpError(400, `invalid path ${JSON.stringify(p)}`);
  }
  return norm;
}

const SHA_RE = /^[0-9a-f]{4,40}$/i;
const oneRef = (r: string) => r === "HEAD" || r === "@{u}" || SHA_RE.test(r) || validBranchName(r);
/** A branch, a sha, HEAD, `@{u}`, or a range of two of them (`HEAD..@{u}` lists incoming commits). */
function validLogRef(ref: string): boolean {
  const parts = ref.split("..");
  return parts.length <= 2 && parts.every((p) => p.length > 0 && oneRef(p));
}
const STASH_RE = /^stash@\{\d{1,4}\}$/;

export function createGitService(deps: Deps, services: Services): GitService {
  const queues = new Map<string, Promise<unknown>>();

  function dir(t: GitTarget): string {
    if (t.kind === "session") {
      const s = services.sessions.get(t.id);
      if (!s) throw new HttpError(404, `unknown session ${t.id}`);
      return s.cwd;
    }
    const p = services.projects.get(t.id);
    if (!p) throw new HttpError(404, `unknown project "${t.id}"`);
    return p.path;
  }
  function repoDir(t: GitTarget): string {
    const d = dir(t);
    if (!existsSync(join(d, ".git"))) throw gitConflict("not-a-repo", "This folder is not a git repository.");
    return d;
  }
  /** Runs a write after earlier writes to the same checkout, then announces it. */
  async function write<T>(t: GitTarget, fn: (cwd: string) => Promise<T>): Promise<T> {
    const cwd = repoDir(t);
    const prev = queues.get(cwd) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => fn(cwd));
    queues.set(cwd, next);
    try {
      return await next.catch((err) => { throw classify(err); });
    } finally {
      if (queues.get(cwd) === next) queues.delete(cwd);
      deps.bus.emit({ type: "git.changed", target: { kind: t.kind, id: t.id } });
    }
  }
  async function read<T>(t: GitTarget, fn: (cwd: string) => Promise<T>): Promise<T> {
    const cwd = repoDir(t);
    try { return await fn(cwd); } catch (err) { throw classify(err); }
  }

  async function stagedPaths(cwd: string): Promise<string[]> {
    const out = await gitOut(cwd, ["diff", "--cached", "--name-only", "-z"]).catch(() => "");
    return out.split("\0").filter(Boolean);
  }

  // ── status ────────────────────────────────────────────────────────────────

  async function statusOf(cwd: string): Promise<GitStatus> {
    const [raw, unstagedNum, stagedNum, gitDir] = await Promise.all([
      gitOut(cwd, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]),
      gitOut(cwd, ["diff", "--numstat", "-z"]).catch(() => ""),
      gitOut(cwd, ["diff", "--cached", "--numstat", "-z"]).catch(() => ""),
      gitOut(cwd, ["rev-parse", "--git-dir"]).then(s => resolve(cwd, s.trim())).catch(() => join(cwd, ".git")),
    ]);
    const p = parseStatusV2(raw);
    const fill = (list: GitChange[], nums: Map<string, [number | null, number | null]>) => {
      for (const c of list) {
        const n = nums.get(c.path);
        if (n) [c.additions, c.deletions] = n;
        else if (c.state === "untracked") {
          const lines = countLines(join(cwd, c.path));
          if (lines !== null) { c.additions = lines; c.deletions = 0; }
        }
      }
    };
    fill(p.staged, parseNumstatZ(stagedNum));
    fill(p.unstaged, parseNumstatZ(unstagedNum));
    let operation: GitStatus["operation"] = null;
    if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) operation = "rebase";
    else if (existsSync(join(gitDir, "MERGE_HEAD"))) operation = "merge";
    else if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) operation = "cherry-pick";
    else if (existsSync(join(gitDir, "REVERT_HEAD"))) operation = "revert";
    let fetchedAt: string | null = null;
    try { fetchedAt = statSync(join(gitDir, "FETCH_HEAD")).mtime.toISOString(); } catch { /* never fetched */ }
    return { repo: true, branch: p.branch, headSha: p.headSha, upstream: p.upstream, ahead: p.ahead, behind: p.behind, upstreamGone: p.upstreamGone, staged: p.staged, unstaged: p.unstaged, conflicted: p.conflicted, operation, fetchedAt };
  }

  const EMPTY: GitStatus = { repo: false, branch: null, headSha: null, upstream: null, ahead: 0, behind: 0, upstreamGone: false, staged: [], unstaged: [], conflicted: [], operation: null, fetchedAt: null };

  async function status(t: GitTarget): Promise<GitStatus> {
    const d = dir(t);
    if (!existsSync(join(d, ".git"))) return { ...EMPTY };
    try { return await statusOf(d); } catch (err) { throw classify(err); }
  }

  // ── diffs and patches ─────────────────────────────────────────────────────

  async function rawDiff(cwd: string, path: string, staged: boolean): Promise<RawFileDiff> {
    if (!staged) {
      const tracked = (await runGit(cwd, ["ls-files", "--error-unmatch", "--", path], { ok: [0, 1] })).code === 0;
      if (!tracked) {
        const abs = join(cwd, path);
        if (!inside(cwd, abs)) throw new HttpError(400, "path outside the checkout");
        const size = statSafe(abs);
        if (size === null) throw new HttpError(404, `no such file ${path}`);
        if (size > MAX_UNTRACKED_BYTES) return { ...addedFileDiff(path, ""), truncated: true };
        const buf = readFileSync(abs);
        if (buf.includes(0)) return { ...addedFileDiff(path, ""), binary: true };
        return addedFileDiff(path, buf.toString("utf8"));
      }
    }
    const out = await gitOut(cwd, ["diff", "--no-ext-diff", "-M", "-U3", ...(staged ? ["--cached"] : []), "--", path]);
    return parseDiff(out)[0] ?? { path, oldPath: null, binary: false, truncated: false, hunks: [], added: false, deleted: false };
  }

  async function applyHunks(cwd: string, hunks: NonNullable<GitPatchRequest["hunks"]>, staged: boolean, args: string[], reverse: boolean): Promise<void> {
    for (const h of hunks) {
      const path = cleanRelPath(h.path);
      const d = await rawDiff(cwd, path, staged);
      if (d.added || d.deleted || d.binary) throw new HttpError(400, `stage or discard ${path} as a whole file`);
      const hunk = d.hunks.find(x => x.id === h.hunkId);
      if (!hunk) throw gitConflict("conflict", `${path} changed since it was shown; refresh and try again`);
      const chosen = h.lines ? new Set(h.lines.filter(n => Number.isInteger(n))) : null;
      await runGit(cwd, ["apply", "--recount", "--whitespace=nowarn", ...args, "-"], { input: hunkPatch(d, hunk, chosen, reverse) });
    }
  }

  const paths = (req: GitPatchRequest) => (req.paths ?? []).map(cleanRelPath);

  // ── service ───────────────────────────────────────────────────────────────

  return {
    status,

    async diff(t, path, staged): Promise<GitFileDiff> {
      const p = cleanRelPath(path);
      return read(t, async cwd => publicDiff(await rawDiff(cwd, p, staged), staged));
    },

    stage: (t, req) => write(t, async cwd => {
      const ps = paths(req);
      if (ps.length) await runGit(cwd, ["add", "-A", "--", ...ps]);
      if (req.hunks?.length) await applyHunks(cwd, req.hunks, false, ["--cached"], false);
      return statusOf(cwd);
    }),

    unstage: (t, req) => write(t, async cwd => {
      const ps = paths(req);
      if (ps.length) {
        const head = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { ok: [0, 1] })).code === 0;
        if (head) await runGit(cwd, ["restore", "--staged", "--", ...ps]);
        else await runGit(cwd, ["rm", "--cached", "-r", "--quiet", "--", ...ps]);
      }
      if (req.hunks?.length) await applyHunks(cwd, req.hunks, true, ["--cached", "--reverse"], true);
      return statusOf(cwd);
    }),

    discard: (t, req) => write(t, async cwd => {
      const ps = paths(req);
      // Whole files go to a stash first, so a discard can always be undone from the stash list.
      if (ps.length) await runGit(cwd, ["stash", "push", "--include-untracked", "--quiet", "-m", `odin-discard: ${ps.length === 1 ? ps[0] : `${ps.length} files`}`, "--", ...ps]);
      if (req.hunks?.length) await applyHunks(cwd, req.hunks, false, ["--reverse"], true);
      return statusOf(cwd);
    }),

    commit: (t, req: GitCommitRequest) => write(t, async (cwd): Promise<GitCommitResult> => {
      const message = typeof req?.message === "string" ? req.message.trim() : "";
      if (!message && !req?.amend) throw new HttpError(400, "message required");
      if (req.all) await runGit(cwd, ["add", "-A"]);
      if (!req.skipActions) {
        const { blocked } = await runTrigger(cwd, "pre-commit", () => stagedPaths(cwd));
        if (blocked) throw gitConflict("action-failed", `${blocked.title} failed, so nothing was committed.`);
      }
      const args = ["commit", "--quiet", "--cleanup=strip", "-F", "-"];
      if (req.amend) args.push("--amend");
      await runGit(cwd, args, { input: message + "\n", timeoutMs: NETWORK_TIMEOUT_MS });
      const sha = (await gitOut(cwd, ["rev-parse", "HEAD"])).trim();
      return { sha, status: await statusOf(cwd) };
    }),

    log: (t, opts) => read(t, async (cwd): Promise<GitLog> => {
      const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), LOG_LIMIT_MAX);
      const skip = Math.max(Number(opts.skip) || 0, 0);
      const args = ["log", `--format=${LOG_FORMAT}`, "--numstat", `-n${limit + 1}`, `--skip=${skip}`];
      if (opts.ref) {
        if (!validLogRef(opts.ref)) throw new HttpError(400, "invalid ref");
        args.push(opts.ref);
      }
      if (opts.path) args.push("--follow", "--", cleanRelPath(opts.path));
      const head = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"], { ok: [0, 1] })).code === 0;
      if (!head) return { commits: [], more: false };
      const commits = parseLog(await gitOut(cwd, args));
      return { commits: commits.slice(0, limit), more: commits.length > limit };
    }),

    show: (t, sha, path) => read(t, async (cwd): Promise<GitCommitDetail> => {
      if (!SHA_RE.test(sha)) throw new HttpError(400, "invalid sha");
      const scope = path ? ["--", cleanRelPath(path)] : [];
      const [meta, patch] = await Promise.all([
        gitOut(cwd, ["show", "-s", `--format=${LOG_FORMAT}`, sha]),
        gitOut(cwd, ["show", "--format=", "--no-ext-diff", "-M", "-U3", sha, ...scope]),
      ]);
      const commit = parseLog(meta)[0];
      if (!commit) throw new HttpError(404, `unknown commit ${sha}`);
      const diffs = parseDiff(patch);
      const files: GitChange[] = diffs.map(d => {
        let additions = 0, deletions = 0;
        for (const h of d.hunks) for (const l of h.lines) { if (l.kind === "add") additions++; else if (l.kind === "del") deletions++; }
        return { path: d.path, oldPath: d.oldPath, state: d.added ? "added" : d.deleted ? "deleted" : d.oldPath ? "renamed" : "modified", additions: d.binary ? null : additions, deletions: d.binary ? null : deletions };
      });
      commit.additions = files.reduce((n, f) => n + (f.additions ?? 0), 0);
      commit.deletions = files.reduce((n, f) => n + (f.deletions ?? 0), 0);
      return { commit, files, diffs: diffs.map(d => publicDiff(d, true)) };
    }),

    blame: (t, path, rev) => read(t, async (cwd): Promise<GitBlame> => {
      const p = cleanRelPath(path);
      if (rev && !SHA_RE.test(rev) && !validBranchName(rev)) throw new HttpError(400, "invalid rev");
      const blame = parseBlamePorcelain(await gitOut(cwd, ["blame", "--porcelain", ...(rev ? [rev] : []), "--", p], { timeoutMs: 30_000 }), p);
      // The session trailers live in commit bodies, which porcelain blame leaves out.
      const shas = Object.keys(blame.commits).filter(s => s !== ZERO_SHA).slice(0, 300);
      if (shas.length) {
        const out = await gitOut(cwd, ["show", "-s", "--format=%x1e%H%x1f%B", ...shas]).catch(() => "");
        for (const rec of out.split("\x1e")) {
          const [sha = "", body = ""] = rec.split("\x1f");
          const c = blame.commits[sha.trim()];
          if (!c) continue;
          Object.assign(c, trailers(body));
          c.body = body.split("\n").slice(1).join("\n").trim();
        }
      }
      return blame;
    }),

    branches: (t) => read(t, async (cwd): Promise<GitBranches> => {
      const [refs, wt] = await Promise.all([
        gitOut(cwd, ["for-each-ref", `--format=${BRANCH_FORMAT}`, "--sort=-committerdate", "refs/heads", "refs/remotes"]),
        gitOut(cwd, ["worktree", "list", "--porcelain"]).catch(() => ""),
      ]);
      const here = normal(cwd);
      const elsewhere = new Map<string, string>();
      for (const w of parseWorktreeList(wt)) if (w.branch && normal(w.path) !== here) elsewhere.set(w.branch, w.path);
      const sessions = services.sessions.list();
      const branches = parseBranches(refs).map(b => {
        const worktree = b.remote ? null : elsewhere.get(b.name) ?? null;
        const owner = worktree ? sessions.find(s => normal(s.cwd) === normal(worktree)) : undefined;
        return { ...b, worktree, worktreeSession: owner?.id ?? null };
      });
      return { current: branches.find(b => b.current)?.name ?? null, branches };
    }),

    checkout: (t, req: GitCheckoutRequest) => write(t, async (cwd): Promise<GitCheckoutResult> => {
      const name = typeof req?.branch === "string" ? req.branch.trim() : "";
      if (!validBranchName(name)) throw new HttpError(400, "invalid branch name");
      if (req.from !== undefined && !validBranchName(req.from) && !SHA_RE.test(req.from)) throw new HttpError(400, "invalid start point");
      const mode = req.dirty ?? "fail";
      const before = await statusOf(cwd);
      const dirty = before.staged.length > 0 || before.unstaged.some(c => c.state !== "untracked");
      if (dirty && mode === "fail") throw gitConflict("dirty-tree", `${before.staged.length + before.unstaged.length} files have uncommitted changes.`);

      // A remote branch name checks out (or creates) the local branch that tracks it.
      const remotes = (await gitOut(cwd, ["remote"])).split("\n").map(s => s.trim()).filter(Boolean);
      const remote = remotes.find(r => name.startsWith(`${r}/`));
      let local = name;
      let args: string[];
      if (req.create) args = ["switch", "--quiet", "-c", name, ...(req.from ? [req.from] : [])];
      else if (remote) {
        local = name.slice(remote.length + 1);
        const exists = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${local}`], { ok: [0, 1] })).code === 0;
        args = exists ? ["switch", "--quiet", local] : ["switch", "--quiet", "-c", local, "--track", name];
      } else args = ["switch", "--quiet", name];

      let stashed: string | null = null;
      if (dirty && mode === "stash") {
        await runGit(cwd, ["stash", "push", "--include-untracked", "--quiet", "-m", `${AUTO_STASH_PREFIX} ${before.branch ?? before.headSha?.slice(0, 7) ?? "HEAD"}`]);
        stashed = "stash@{0}";
      }
      try {
        await runGit(cwd, args);
      } catch (err) {
        if (stashed) await runGit(cwd, ["stash", "pop", "--quiet"]).catch(() => {});
        throw err;
      }
      // Coming back to a branch puts its auto-stash back when the tree is clean.
      let restored = false;
      const after = await statusOf(cwd);
      const clean = after.staged.length === 0 && after.unstaged.every(c => c.state === "untracked");
      if (clean) {
        const auto = parseStashes(await gitOut(cwd, ["stash", "list", `--format=${STASH_FORMAT}`])).find(s => s.message === `${AUTO_STASH_PREFIX} ${local}`);
        if (auto) restored = (await runGit(cwd, ["stash", "pop", "--quiet", auto.ref], { ok: [0, 1] })).code === 0;
      }
      if (stashed) stashed = parseStashes(await gitOut(cwd, ["stash", "list", `--format=${STASH_FORMAT}`])).find(s => s.message === `${AUTO_STASH_PREFIX} ${before.branch ?? ""}`)?.ref ?? stashed;
      return { branch: local, stashed, restored, status: restored ? await statusOf(cwd) : after };
    }),

    fetch: (t) => write(t, async (cwd): Promise<GitSyncResult> => {
      await runGit(cwd, ["fetch", "--all", "--prune", "--quiet"], { timeoutMs: NETWORK_TIMEOUT_MS });
      const s = await statusOf(cwd);
      return { message: s.behind ? `${s.behind} new ${s.behind === 1 ? "commit" : "commits"} on ${s.upstream}` : "Up to date", status: s };
    }),

    pull: (t, req: GitPullRequest) => write(t, async (cwd): Promise<GitSyncResult> => {
      const before = await statusOf(cwd);
      if (!before.upstream || before.upstreamGone) throw gitConflict("no-upstream", "This branch has no upstream to pull from.");
      const strategy = req?.strategy ?? "ff-only";
      const flag = strategy === "rebase" ? ["--rebase", "--autostash"] : strategy === "merge" ? ["--no-rebase", "--autostash"] : ["--ff-only", "--autostash"];
      await runGit(cwd, ["pull", "--quiet", ...flag], { timeoutMs: NETWORK_TIMEOUT_MS });
      const s = await statusOf(cwd);
      const n = before.behind;
      return { message: n ? `Pulled ${n} ${n === 1 ? "commit" : "commits"}${strategy === "ff-only" ? "" : ` (${strategy})`}` : "Already up to date", status: s };
    }),

    push: (t, req: GitPushRequest) => write(t, async (cwd): Promise<GitSyncResult> => {
      const before = await statusOf(cwd);
      if (!before.branch) throw new HttpError(400, "check out a branch before pushing");
      const args = ["push", "--quiet"];
      if (req?.forceWithLease) args.push("--force-with-lease");
      let pushed = before.ahead;
      if (!before.upstream || before.upstreamGone) {
        if (req?.setUpstream === false) throw gitConflict("no-upstream", "This branch has no upstream yet.");
        args.push("-u", "origin", before.branch);
        pushed = Number((await gitOut(cwd, ["rev-list", "--count", "HEAD", "--not", "--remotes"]).catch(() => "0")).trim()) || 0;
      }
      let warned: GitAction[] = [];
      if (!req?.skipActions) {
        const result = await runTrigger(cwd, "pre-push", async () => []);
        if (result.blocked) throw gitConflict("action-failed", `${result.blocked.title} failed, so nothing was pushed.`);
        warned = result.warned;
      }
      await runGit(cwd, args, { timeoutMs: NETWORK_TIMEOUT_MS });
      const message = pushed ? `Pushed ${pushed} ${pushed === 1 ? "commit" : "commits"}` : "Pushed";
      const warning = warned.length ? ` (${warned.map((a) => a.title).join(", ")} failed)` : "";
      return { message: message + warning, status: await statusOf(cwd) };
    }),

    actions: (t) => read(t, async (cwd): Promise<GitAction[]> => loadActions(cwd)),

    runAction: (t, id) => read(t, async (cwd): Promise<GitActionRun> => {
      const action = loadActions(cwd).find((a) => a.id === id);
      if (!action) throw new HttpError(404, `unknown git action ${JSON.stringify(id)}`);
      if (action.error) throw new HttpError(400, `${action.file}: ${action.error}`);
      return runAction(cwd, action, await stagedPaths(cwd));
    }),

    stashes: (t) => read(t, async (cwd): Promise<GitStash[]> => parseStashes(await gitOut(cwd, ["stash", "list", `--format=${STASH_FORMAT}`]))),

    stash: (t, req: GitStashRequest) => write(t, async cwd => {
      const args = ["stash", "push", "--quiet"];
      if (req?.includeUntracked !== false) args.push("--include-untracked");
      if (typeof req?.message === "string" && req.message.trim()) args.push("-m", req.message.trim().slice(0, 200));
      await runGit(cwd, args);
      return statusOf(cwd);
    }),

    stashAction: (t, action, ref) => write(t, async cwd => {
      if (!STASH_RE.test(ref)) throw new HttpError(400, "invalid stash ref");
      await runGit(cwd, ["stash", action, "--quiet", ref]);
      return statusOf(cwd);
    }),
  };
}

function countLines(abs: string): number | null {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_UNTRACKED_BYTES) return null;
    const buf = readFileSync(abs);
    if (buf.includes(0)) return null;
    if (buf.length === 0) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
  } catch {
    return null;
  }
}
function statSafe(abs: string): number | null {
  try { const st = statSync(abs); return st.isFile() ? st.size : null; } catch { return null; }
}
function inside(root: string, abs: string): boolean {
  const r = resolve(root) + sep;
  return resolve(abs).startsWith(r);
}
function normal(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
