// Local git: the working tree, index, branches, stashes and history of a session's worktree or a project's folder.
// docs/contracts.md#git. Every route exists twice, under /api/sessions/:id/git and /api/projects/:name/git.

/** Which checkout a git call works on: a session's working directory, or a registered project's folder. */
export interface GitTarget {
  kind: "session" | "project";
  id: string;
}

export type GitFileState = "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "untracked" | "conflicted";

export interface GitChange {
  path: string;
  /** The old name of a rename or copy, else null. */
  oldPath: string | null;
  state: GitFileState;
  /** Line counts; null for binary files and untracked files over the size limit. */
  additions: number | null;
  deletions: number | null;
}

/** GET …/git/status */
export interface GitStatus {
  /** False when the folder is not a git checkout; everything else is then empty. */
  repo: boolean;
  /** Short branch name, or null when detached. */
  branch: string | null;
  headSha: string | null;
  /** `origin/main`-style upstream, or null. */
  upstream: string | null;
  /** Commits on the branch not on its upstream, and the other way round (0 without an upstream). */
  ahead: number;
  behind: number;
  /** True when the upstream branch was deleted on the remote. */
  upstreamGone: boolean;
  staged: GitChange[];
  /** Working-tree changes not in the index, untracked files included. */
  unstaged: GitChange[];
  /** Files with merge conflicts (also listed in `unstaged` as `conflicted`). */
  conflicted: string[];
  /** An operation left half-done in this checkout. */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  /** When FETCH_HEAD last changed, or null. */
  fetchedAt: string | null;
}

export interface GitDiffLine {
  kind: "context" | "add" | "del";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface GitHunk {
  /** Stable for the same hunk content: `<oldStart>,<newStart>:<hash>`. Pass it back to stage, unstage or discard. */
  id: string;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The function or section name git prints after the header, or "". */
  section: string;
  lines: GitDiffLine[];
}

/** GET …/git/diff?path=&staged=1 (index against HEAD when staged, else the working tree against the index). */
export interface GitFileDiff {
  path: string;
  oldPath: string | null;
  staged: boolean;
  binary: boolean;
  hunks: GitHunk[];
  /** True when the diff was cut at the size limit. */
  truncated: boolean;
}

/**
 * POST …/git/stage, …/git/unstage, …/git/discard. Whole files by `paths`, or single hunks by id. `lines` narrows a
 * hunk to some of its changed lines (indexes into the hunk's `lines`); the rest of the hunk is left as it is.
 * Discard of whole files also removes untracked files, after copying everything to a safety stash.
 */
export interface GitPatchRequest {
  paths?: string[];
  hunks?: { path: string; hunkId: string; lines?: number[] }[];
}

/** POST …/git/commit. Commits what is staged. `all` stages every change first. */
export interface GitCommitRequest {
  message: string;
  amend?: boolean;
  all?: boolean;
  /** Skip the pre-commit git actions ("Commit anyway"). */
  skipActions?: boolean;
}

export interface GitCommitResult {
  sha: string;
  status: GitStatus;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  at: string;
  parents: string[];
  /** From an `Odin-Session: <id>` trailer, or null. */
  sessionId: string | null;
  /** From an `Odin-Turns: <n>[-<m>]` trailer, or null. */
  turns: string | null;
  /** Lines added and removed (in the file when the log was asked for one path). Null when unknown. */
  additions: number | null;
  deletions: number | null;
}

/** GET …/git/log?path=&ref=&limit=&skip= */
export interface GitLog {
  commits: GitCommit[];
  /** True when more commits follow (ask again with skip). */
  more: boolean;
}

/** GET …/git/show?sha=&path= : one commit and its diff (limited to `path` when given). */
export interface GitCommitDetail {
  commit: GitCommit;
  files: GitChange[];
  diffs: GitFileDiff[];
}

export interface GitBlameRange {
  sha: string;
  /** 1-based first line in the current file, and how many lines the range covers. */
  start: number;
  lines: number;
}

/** GET …/git/blame?path=&rev= . Uncommitted lines carry the all-zero sha. */
export interface GitBlame {
  path: string;
  ranges: GitBlameRange[];
  commits: Record<string, GitCommit>;
}

export interface GitBranch {
  /** `main`, or `origin/feat/x` for a remote branch. */
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
  headSha: string;
  subject: string;
  lastCommitAt: string;
  /** Another worktree that has this branch checked out (it can't be checked out here), else null. */
  worktree: string | null;
  /** The Odin session working in that worktree, when there is one. */
  worktreeSession: string | null;
}

/** GET …/git/branches */
export interface GitBranches {
  current: string | null;
  branches: GitBranch[];
}

/**
 * POST …/git/checkout. `create` makes `branch` from `from` (default HEAD); a remote name (`origin/x`) checks out a
 * local tracking branch `x`. `dirty` says what to do with uncommitted changes: `stash` puts them in an auto-stash that
 * comes back when you return to this branch, `carry` keeps them (409 `conflict` when git refuses), `fail` (default)
 * answers 409 `dirty-tree` without touching anything.
 */
export interface GitCheckoutRequest {
  branch: string;
  create?: boolean;
  from?: string;
  dirty?: "stash" | "carry" | "fail";
}

export interface GitCheckoutResult {
  branch: string;
  /** The auto-stash made from the old branch's changes, or null. */
  stashed: string | null;
  /** True when an auto-stash for the new branch was put back. */
  restored: boolean;
  status: GitStatus;
}

/** POST …/git/fetch, …/git/pull, …/git/push */
export interface GitPullRequest {
  strategy?: "ff-only" | "rebase" | "merge";
}
export interface GitPushRequest {
  /** Skip the pre-push git actions. */
  skipActions?: boolean;
  /** Sets the upstream to origin/<branch> when there is none (default true). */
  setUpstream?: boolean;
  forceWithLease?: boolean;
}
export interface GitSyncResult {
  /** One line for a toast: "Pulled 1 commit, pushed 2". */
  message: string;
  status: GitStatus;
}

export interface GitStash {
  /** `stash@{0}` */
  ref: string;
  message: string;
  /** The branch it was made on. */
  branch: string | null;
  at: string;
  /** True for the auto-stash Odin makes when you switch branches. */
  auto: boolean;
}

/** POST …/git/stash { message?, includeUntracked? } ; POST …/git/stash/apply|pop|drop { ref } */
export interface GitStashRequest {
  message?: string;
  includeUntracked?: boolean;
}

/** Codes on a 409 from git routes, in the JSON body's `code`. */
export type GitErrorCode = "dirty-tree" | "conflict" | "diverged" | "no-upstream" | "auth" | "checked-out-elsewhere" | "nothing-to-commit" | "not-a-repo" | "action-failed";

/** When a git action runs: before a commit or push made from Odin, or only when asked. */
export type GitActionTrigger = "pre-commit" | "pre-push" | "manual";

/** One run of a git action. `output` is the last 16 KB of stdout and stderr together. */
export interface GitActionRun {
  ok: boolean;
  at: string;
  durationMs: number;
  /** Null when it was killed (timeout) or couldn't start. */
  exitCode: number | null;
  timedOut: boolean;
  /** The argv as run, with `$STAGED` expanded. */
  command: string[];
  output: string;
}

/**
 * A git action: a command the repo asks Odin to run around its git writes, defined in `.odin/git-actions/<id>.json`:
 * `{ "title", "description"?, "on": "pre-commit" | "pre-push" | "manual", "run": ["argv", "…"], "blocking"?,
 * "timeoutSec"?, "enabled"? }`. `run` is an argv (no shell); an argument `$STAGED` expands to the staged paths.
 * A blocking action that fails stops the commit or push (409 `action-failed`); a non-blocking one is reported.
 */
export interface GitAction {
  id: string;
  title: string;
  description: string;
  on: GitActionTrigger;
  run: string[];
  /** Default: true before a commit, false before a push. */
  blocking: boolean;
  timeoutSec: number;
  enabled: boolean;
  /** Repo-relative path of the definition. */
  file: string;
  /** Why the definition can't be used (bad JSON, missing fields); the action is then skipped. */
  error: string | null;
  /** The latest run since Odin started, or null. */
  lastRun: GitActionRun | null;
}

/** Folder of git action definitions, relative to the checkout. */
export const GIT_ACTIONS_DIR = ".odin/git-actions";

/** Trailer keys Odin adds to commit messages drafted from a session. */
export const SESSION_TRAILER = "Odin-Session";
export const TURNS_TRAILER = "Odin-Turns";
/** Message prefix of the stash Odin makes when switching branches with changes. */
export const AUTO_STASH_PREFIX = "odin-autostash:";
