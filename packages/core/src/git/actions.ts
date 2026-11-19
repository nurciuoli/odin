// Git actions: commands a repo asks Odin to run before its commits and pushes, or on demand, defined in
// `.odin/git-actions/*.json`. Run with execFile and an argv (never a shell); `$STAGED` expands to the staged paths.
// The latest run of each action is kept in memory for the Library and the blocked-commit view.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitAction, GitActionRun, GitActionTrigger } from "@odin/shared/git";
import { GIT_ACTIONS_DIR } from "@odin/shared/git";

const OUTPUT_TAIL = 16 * 1024;
const MAX_TIMEOUT_SEC = 30 * 60;
const TRIGGERS: GitActionTrigger[] = ["pre-commit", "pre-push", "manual"];
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** cwd → action id → latest run */
const lastRuns = new Map<string, Map<string, GitActionRun>>();

/** Reads every definition in the checkout. Bad files come back with `error` set rather than failing the list. */
export function loadActions(cwd: string): GitAction[] {
  const folder = join(cwd, GIT_ACTIONS_DIR);
  if (!existsSync(folder)) return [];
  const runs = lastRuns.get(cwd);
  return readdirSync(folder)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const id = f.slice(0, -".json".length);
      const base: GitAction = {
        id, title: id, description: "", on: "manual", run: [], blocking: false, timeoutSec: 120, enabled: false,
        file: `${GIT_ACTIONS_DIR}/${f}`, error: null, lastRun: runs?.get(id) ?? null,
      };
      if (!ID_RE.test(id)) return { ...base, error: "file name must be letters, digits, dots, dashes or underscores" };
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(join(folder, f), "utf8"));
      } catch (err) {
        return { ...base, error: `not valid JSON: ${(err as Error).message}` };
      }
      const d = raw as Record<string, unknown>;
      if (!d || typeof d !== "object" || Array.isArray(d)) return { ...base, error: "must be a JSON object" };
      if (!TRIGGERS.includes(d.on as GitActionTrigger)) return { ...base, error: `"on" must be one of ${TRIGGERS.join(", ")}` };
      if (!Array.isArray(d.run) || !d.run.length || !d.run.every((a) => typeof a === "string" && a.length > 0))
        return { ...base, error: '"run" must be a non-empty array of strings (an argv; no shell)' };
      const on = d.on as GitActionTrigger;
      const timeout = Number(d.timeoutSec);
      return {
        ...base,
        title: typeof d.title === "string" && d.title.trim() ? d.title.trim() : id,
        description: typeof d.description === "string" ? d.description : "",
        on,
        run: d.run as string[],
        blocking: typeof d.blocking === "boolean" ? d.blocking : on === "pre-commit",
        timeoutSec: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, MAX_TIMEOUT_SEC) : 120,
        enabled: d.enabled !== false,
      };
    });
}

/** Runs one action in the checkout and remembers the run. Never throws: a failure is a run with `ok: false`. */
export function runAction(cwd: string, action: GitAction, staged: string[]): Promise<GitActionRun> {
  const argv = action.run.flatMap((a) => (a === "$STAGED" ? staged : [a]));
  const started = Date.now();
  return new Promise((resolve) => {
    const [file, ...args] = argv;
    execFile(
      file!,
      args,
      { cwd, timeout: action.timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, ODIN_GIT_ACTION: action.id } },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null; code?: number | string }) | null;
        const timedOut = !!e?.killed && e.signal === "SIGTERM";
        let output = `${stdout ?? ""}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
        if (e && !stdout && !stderr) output = e.message;
        if (timedOut) output += `\nStopped after ${action.timeoutSec}s.`;
        if (output.length > OUTPUT_TAIL) output = "…" + output.slice(-OUTPUT_TAIL);
        const run: GitActionRun = {
          ok: !e,
          at: new Date(started).toISOString(),
          durationMs: Date.now() - started,
          exitCode: e ? (typeof e.code === "number" ? e.code : null) : 0,
          timedOut,
          command: argv,
          output,
        };
        let runs = lastRuns.get(cwd);
        if (!runs) lastRuns.set(cwd, (runs = new Map()));
        runs.set(action.id, run);
        resolve({ ...run });
      },
    );
  });
}

/**
 * Runs the enabled actions for a trigger, in file order. Stops at the first blocking failure and returns it;
 * non-blocking failures are collected.
 */
export async function runTrigger(
  cwd: string,
  on: "pre-commit" | "pre-push",
  staged: () => Promise<string[]>,
): Promise<{ blocked: GitAction | null; warned: GitAction[] }> {
  const actions = loadActions(cwd).filter((a) => a.on === on && a.enabled && !a.error);
  if (!actions.length) return { blocked: null, warned: [] };
  const paths = await staged();
  const warned: GitAction[] = [];
  for (const a of actions) {
    const run = await runAction(cwd, a, paths);
    if (run.ok) continue;
    if (a.blocking) return { blocked: { ...a, lastRun: run }, warned };
    warned.push({ ...a, lastRun: run });
  }
  return { blocked: null, warned };
}
