// The composer's `!` mode: runs one user-typed command in a session's working directory and returns its output.
// Odin runs it, so it behaves the same for every harness. docs/contracts.md#sessions (Shell commands).
import { spawn } from "node:child_process";
import type { ShellRunResult } from "@odin/shared/api";

export const SHELL_TIMEOUT_MS = 120_000;
export const SHELL_MAX_OUTPUT = 128 * 1024;
export const SHELL_MAX_COMMAND = 8 * 1024;

/** Odin's own secrets and tokens never reach a command the user runs from the app. */
const SECRET_ENV = /^(ODIN_.*(TOKEN|SECRET|KEY)|GITHUB_TOKEN|GH_TOKEN)$/;

export function shellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k)) out[k] = v;
  return out;
}

export interface ShellOptions {
  timeoutMs?: number;
  maxOutput?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * The command is typed by the user, as in a terminal, so it goes to the platform shell as one string; nothing
 * Odin builds from other input is ever interpolated into it.
 */
export function runShell(cwd: string, command: string, opts: ShellOptions = {}): Promise<ShellRunResult> {
  const timeoutMs = opts.timeoutMs ?? SHELL_TIMEOUT_MS;
  const max = opts.maxOutput ?? SHELL_MAX_OUTPUT;
  const win = process.platform === "win32";
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(win ? "cmd.exe" : "/bin/sh", win ? ["/d", "/s", "/c", command] : ["-c", command], {
      cwd, env: shellEnv(opts.env ?? process.env), stdio: ["ignore", "pipe", "pipe"], detached: !win, windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const take = (data: Buffer) => {
      if (size >= max) { truncated = true; return; }
      const room = max - size;
      chunks.push(data.length > room ? data.subarray(0, room) : data);
      if (data.length > room) truncated = true;
      size += Math.min(room, data.length);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const kill = () => {
      try { if (!win && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const finish = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command, cwd, output: Buffer.concat(chunks).toString("utf8") + extra, exitCode: timedOut ? null : exitCode,
        timedOut, truncated, durationMs: Date.now() - started,
      });
    };
    child.on("error", (e) => finish(null, `${chunks.length ? "\n" : ""}${e.message}\n`));
    child.on("close", (code) => finish(code));
  });
}
