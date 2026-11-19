import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_ACTIONS_DIR } from "@odin/shared/git";
import { removeTempDir, tempDir } from "../test-helpers.ts";
import { loadActions, runAction, runTrigger } from "./actions.ts";

const root = tempDir("odin-git-actions-");
after(() => removeTempDir(root));
let n = 0;

/** A checkout whose .odin/git-actions holds the given files (objects are written as JSON). */
function checkout(files: Record<string, unknown>): string {
  const cwd = join(root, `repo-${n++}`);
  mkdirSync(join(cwd, GIT_ACTIONS_DIR), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(cwd, GIT_ACTIONS_DIR, name), typeof body === "string" ? body : JSON.stringify(body));
  return cwd;
}
const node = (code: string) => [process.execPath, "-e", code];

test("a checkout with no actions folder has no actions", () => {
  assert.deepEqual(loadActions(join(root, "nothing-here")), []);
});

test("definitions get defaults: blocking only for pre-commit, 120s timeout, enabled", () => {
  const cwd = checkout({ "lint.json": { on: "pre-commit", run: ["x"] }, "push.json": { on: "pre-push", run: ["x"], title: " Push check ", timeoutSec: 99999, enabled: false } });
  const [lint, push] = loadActions(cwd);
  assert.deepEqual([lint!.id, lint!.title, lint!.blocking, lint!.timeoutSec, lint!.enabled, lint!.error], ["lint", "lint", true, 120, true, null]);
  assert.deepEqual([push!.title, push!.blocking, push!.timeoutSec, push!.enabled], ["Push check", false, 30 * 60, false]);
});

test("bad definitions come back with an error instead of failing the list", () => {
  const cwd = checkout({
    "a-json.json": "{nope",
    "b-array.json": "[]",
    "c-on.json": { on: "post-commit", run: ["x"] },
    "d-run.json": { on: "manual", run: [] },
    "e-run.json": { on: "manual", run: ["ok", 5] },
    ".bad id.json": { on: "manual", run: ["x"] },
    "notes.txt": "ignored",
  });
  const errors = loadActions(cwd).map((a) => [a.id, a.error?.split(":")[0]]);
  assert.deepEqual(errors, [
    [".bad id", "file name must be letters, digits, dots, dashes or underscores"],
    ["a-json", "not valid JSON"],
    ["b-array", "must be a JSON object"],
    ["c-on", '"on" must be one of pre-commit, pre-push, manual'],
    ["d-run", '"run" must be a non-empty array of strings (an argv; no shell)'],
    ["e-run", '"run" must be a non-empty array of strings (an argv; no shell)'],
  ]);
});

test("runAction records output and exit code, expands $STAGED, and never throws", async () => {
  const cwd = checkout({ "echo.json": { on: "manual", run: [...node("console.log(process.argv.slice(1).join('|'))"), "$STAGED"] } });
  const [action] = loadActions(cwd);
  const run = await runAction(cwd, action!, ["a.ts", "b.ts"]);
  assert.deepEqual([run.ok, run.exitCode, run.timedOut, run.output.trim()], [true, 0, false, "a.ts|b.ts"]);
  assert.equal(loadActions(cwd)[0]!.lastRun?.output.trim(), "a.ts|b.ts");

  const failing = await runAction(cwd, { ...action!, run: node("console.error('bad'); process.exit(3)") }, []);
  assert.deepEqual([failing.ok, failing.exitCode, failing.output.trim()], [false, 3, "bad"]);

  const missing = await runAction(cwd, { ...action!, run: ["definitely-not-a-real-command-odin"] }, []);
  assert.equal(missing.ok, false);
  assert.equal(missing.exitCode, null);
});

test("runAction stops a command that outlives its timeout", async () => {
  const cwd = checkout({});
  const run = await runAction(cwd, { id: "slow", run: node("setTimeout(() => {}, 30000)"), timeoutSec: 0.2 } as never, []);
  assert.deepEqual([run.ok, run.timedOut], [false, true]);
  assert.match(run.output, /Stopped after 0.2s/);
});

test("runTrigger: a blocking failure stops the run, a non-blocking one only warns, disabled actions are skipped", async () => {
  const cwd = checkout({
    "1-warn.json": { on: "pre-commit", blocking: false, run: node("process.exit(1)") },
    "2-off.json": { on: "pre-commit", enabled: false, run: node("process.exit(1)") },
    "3-block.json": { on: "pre-commit", run: node("process.exit(2)") },
    "4-never.json": { on: "pre-commit", run: node("process.exit(0)") },
    "5-push.json": { on: "pre-push", run: node("process.exit(1)") },
  });
  const out = await runTrigger(cwd, "pre-commit", async () => ["f.ts"]);
  assert.equal(out.blocked?.id, "3-block");
  assert.equal(out.blocked?.lastRun?.exitCode, 2);
  assert.deepEqual(out.warned.map((a) => a.id), ["1-warn"]);
  const ran = loadActions(cwd).filter((a) => a.lastRun).map((a) => a.id);
  assert.deepEqual(ran, ["1-warn", "3-block"]);
});

test("runTrigger asks for the staged paths only when something will run", async () => {
  let asked = 0;
  const none = checkout({ "m.json": { on: "manual", run: ["x"] } });
  assert.deepEqual(await runTrigger(none, "pre-commit", async () => (asked++, [])), { blocked: null, warned: [] });
  assert.equal(asked, 0);
});
