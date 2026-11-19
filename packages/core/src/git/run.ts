// Runs git for the git service. `execFile("git", argv)`, never a shell, always with a timeout; optional stdin.
import { execFile } from "node:child_process";
import type { GitErrorCode } from "@odin/shared/git";
import { HttpError } from "../http/util.ts";
import { gitBinary } from "../tools/resolve.ts";

export const READ_TIMEOUT_MS = 15_000;
export const NETWORK_TIMEOUT_MS = 120_000;

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs git in `cwd`. Resolves for exit codes in `ok` (default [0]); otherwise rejects with a GitRunError. */
export function runGit(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number; ok?: number[] } = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  const ok = opts.ok ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitBinary(),
      ["-c", "core.quotePath=false", "-c", "color.ui=false", ...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no" },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        const code = e ? (typeof e.code === "number" ? e.code : -1) : 0;
        if (!e || ok.includes(code)) return resolve({ stdout: String(stdout), stderr: String(stderr), code });
        const why = e.killed ? `timed out after ${timeoutMs}ms` : firstLine(String(stderr)) || firstLine(String(stdout)) || e.message;
        reject(new GitRunError(`git ${args[0]}: ${why}`, String(stderr) + String(stdout)));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

export async function gitOut(cwd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<string> {
  return (await runGit(cwd, args, opts)).stdout;
}

const firstLine = (s: string) => s.split("\n").map(l => l.replace(/^(error|fatal|hint): /, "").trim()).find(Boolean) ?? "";

export class GitRunError extends Error {
  readonly output: string;
  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}

/** A 409 with a code the UI can act on. */
export function gitConflict(code: GitErrorCode, message: string): HttpError {
  return new HttpError(409, message, code);
}

/** Maps git's own failure text to a typed 409 when it is one the UI handles, else a 400 with git's message. */
export function classify(err: unknown): unknown {
  if (!(err instanceof GitRunError)) return err;
  const out = err.output;
  if (/Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled/i.test(out)) return gitConflict("auth", "git could not sign in to the remote. Check your git credentials.");
  if (/already (checked out|used by worktree) at/i.test(out)) return gitConflict("checked-out-elsewhere", "That branch is checked out in another worktree.");
  if (/would be overwritten by (checkout|merge)|Please commit your changes or stash them/i.test(out)) return gitConflict("dirty-tree", "Uncommitted changes would be overwritten.");
  if (/CONFLICT|could not apply|Merge conflict|patch does not apply/i.test(out)) return gitConflict("conflict", err.message);
  if (/Not possible to fast-forward|non-fast-forward|\[rejected\]|fetch first|Need to specify how to reconcile/i.test(out)) return gitConflict("diverged", "The branch and its upstream have diverged.");
  if (/no upstream|has no upstream branch|no tracking information/i.test(out)) return gitConflict("no-upstream", "This branch has no upstream yet.");
  if (/nothing to commit|nothing added to commit|no changes added to commit/i.test(out)) return gitConflict("nothing-to-commit", "Nothing is staged to commit.");
  return new HttpError(400, err.message);
}
