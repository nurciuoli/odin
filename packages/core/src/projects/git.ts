// Git for a project's main clone. Always `execFile("git", argv)`, never a shell, always with a timeout. Odin
// reads state here and makes exactly the scaffold writes: init, the first commit, `remote add` and `push -u`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gitBinary } from "../tools/resolve.ts";
import type { GitState } from "@odin/shared/api";

const DEFAULT_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 120_000;

export class GitError extends Error {
  readonly code: number | string | null;
  constructor(message: string, code: number | string | null) {
    super(message);
    this.code = code;
  }
}

/** Runs git in `cwd` and returns stdout. Rejects with GitError (stderr's first line) on failure or timeout. */
export function git(cwd: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      gitBinary(),
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0", // never wait for a password
          GIT_OPTIONAL_LOCKS: "0", // reading status must not take index.lock from under the user's own git work
          LC_ALL: "C",
        },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        const why = e.killed ? `timed out after ${timeoutMs}ms` : String(stderr).trim().split("\n")[0] || e.message;
        reject(new GitError(`git ${args[0]}: ${why}`, e.code ?? null));
      },
    );
  });
}

export function isGitRepo(path: string): boolean {
  return existsSync(join(path, ".git"));
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** Paths from `git status --porcelain -z`: modified, added, deleted, renamed (new name) and untracked files. */
export function parseStatusZ(out: string): string[] {
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (/[RC]/.test(xy)) i++; // the original name follows as its own entry
  }
  return paths;
}

export async function statusPaths(path: string): Promise<string[]> {
  return parseStatusZ(await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
}

export const EMPTY_GIT: GitState = { branch: null, headSha: null, dirty: false, ahead: 0, behind: 0 };

/** Branch, head, dirty, and ahead/behind origin/<defaultBranch>, plus the dirty paths. Not a repo: empty state. */
export async function readGitState(path: string, defaultBranch: string): Promise<{ state: GitState; dirtyPaths: string[] }> {
  if (!isGitRepo(path)) return { state: { ...EMPTY_GIT }, dirtyPaths: [] };
  const [branch, head, dirtyPaths, remotes] = await Promise.all([
    git(path, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ""),
    git(path, ["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => ""),
    statusPaths(path).catch(() => [] as string[]),
    git(path, ["remote"]).catch(() => ""),
  ]);
  let ahead = 0;
  let behind = 0;
  const local = `refs/heads/${defaultBranch}`;
  const remote = `refs/remotes/origin/${defaultBranch}`;
  if (remotes.split("\n").map((s) => s.trim()).includes("origin") && (await refExists(path, local)) && (await refExists(path, remote))) {
    const counts = (await git(path, ["rev-list", "--left-right", "--count", `${local}...${remote}`]).catch(() => "0 0")).trim().split(/\s+/);
    ahead = Number(counts[0]) || 0;
    behind = Number(counts[1]) || 0;
  }
  return {
    state: { branch: branch.trim() || null, headSha: head.trim() || null, dirty: dirtyPaths.length > 0, ahead, behind },
    dirtyPaths,
  };
}

export async function currentBranch(path: string): Promise<string | null> {
  return (await git(path, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => "")).trim() || null;
}

/** `owner/name` from a GitHub remote URL (https or ssh), else null. */
export function repoFromRemoteUrl(url: string): string | null {
  const m = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function originRepo(path: string): Promise<string | null> {
  const url = (await git(path, ["remote", "get-url", "origin"]).catch(() => "")).trim();
  return url ? repoFromRemoteUrl(url) : null;
}

export async function initRepo(path: string, branch: string): Promise<void> {
  await git(path, ["init", "--quiet", `--initial-branch=${branch}`]);
}

/** Stages everything and commits. A missing git identity falls back to Odin's so the scaffold commit can't fail on it. */
export async function commitAll(path: string, message: string): Promise<void> {
  await git(path, ["add", "-A"]);
  const identity: string[] = [];
  const name = (await git(path, ["config", "user.name"]).catch(() => "")).trim();
  const email = (await git(path, ["config", "user.email"]).catch(() => "")).trim();
  if (!name) identity.push("-c", "user.name=Odin");
  if (!email) identity.push("-c", "user.email=odin@localhost");
  await git(path, [...identity, "commit", "--quiet", "--no-verify", "-m", message]);
}

export async function addRemote(path: string, name: string, url: string): Promise<void> {
  await git(path, ["remote", "add", name, url]);
}

/** `git push -u origin <branch>` with the user's own git credentials. */
export async function pushUpstream(path: string, branch: string): Promise<void> {
  await git(path, ["push", "--quiet", "-u", "origin", branch], PUSH_TIMEOUT_MS);
}

// ── branches and worktrees (read-only) ───────────────────────────────────────

export interface LocalBranch {
  name: string;
  headSha: string;
  lastCommitAt: string;
}

/** Every local branch (`git for-each-ref refs/heads`). */
export async function listBranches(path: string): Promise<LocalBranch[]> {
  const out = await git(path, ["for-each-ref", "--format=%(refname:lstrip=2)%00%(objectname)%00%(committerdate:iso-strict)", "refs/heads"]);
  return out.split("\n").filter(Boolean).map((line) => {
    const [name = "", headSha = "", date = ""] = line.split("\0");
    const t = Date.parse(date);
    return { name, headSha, lastCommitAt: Number.isFinite(t) ? new Date(t).toISOString() : date };
  }).filter((b) => b.name);
}

export interface WorktreeEntry {
  path: string;
  /** Short branch name, or null when detached or bare. */
  branch: string | null;
}

/** `git worktree list --porcelain`, main checkout first. */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of out.split(/\n\s*\n/)) {
    let path: string | null = null, branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length);
    }
    if (path) entries.push({ path, branch });
  }
  return entries;
}

export async function listWorktrees(path: string): Promise<WorktreeEntry[]> {
  return parseWorktreeList(await git(path, ["worktree", "list", "--porcelain"]));
}

/** origin/<default> when it exists, else <default>, else null. */
export async function defaultBase(path: string, defaultBranch: string): Promise<string | null> {
  if (await refExists(path, `refs/remotes/origin/${defaultBranch}`)) return `refs/remotes/origin/${defaultBranch}`;
  if (await refExists(path, `refs/heads/${defaultBranch}`)) return `refs/heads/${defaultBranch}`;
  return null;
}

/** Commits on `branch` not on `base` (ahead) and the other way round (behind). */
export async function aheadBehind(path: string, base: string, branch: string): Promise<{ ahead: number; behind: number }> {
  const out = await git(path, ["rev-list", "--left-right", "--count", `${base}...refs/heads/${branch}`]);
  const [behind = "0", ahead = "0"] = out.trim().split(/\s+/);
  return { ahead: Number(ahead) || 0, behind: Number(behind) || 0 };
}

/** Local branches fully merged into `base`. */
export async function mergedBranches(path: string, base: string): Promise<Set<string>> {
  const out = await git(path, ["for-each-ref", "--format=%(refname:lstrip=2)", `--merged=${base}`, "refs/heads"]);
  return new Set(out.split("\n").map((s) => s.trim()).filter(Boolean));
}
