import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { runShell, shellEnv } from "./shell.ts";

const posix = process.platform !== "win32";

test("runShell reports output and exit code", async () => {
  const r = await runShell(tmpdir(), "echo hi");
  assert.equal(r.exitCode, 0);
  assert.match(r.output, /hi/);
  assert.equal(r.truncated, false);
});

test("runShell caps output", { skip: !posix }, async () => {
  const r = await runShell(tmpdir(), "head -c 5000 /dev/zero | tr '\\0' x", { maxOutput: 100 });
  assert.equal(r.output.length, 100);
  assert.equal(r.truncated, true);
});

test("runShell kills a command at the timeout", { skip: !posix }, async () => {
  const r = await runShell(tmpdir(), "echo start; sleep 30", { timeoutMs: 200 });
  assert.equal(r.timedOut, true);
  assert.equal(r.exitCode, null);
  assert.match(r.output, /start/);
});

test("shellEnv drops Odin and GitHub secrets", () => {
  const env = shellEnv({ PATH: "/bin", ODIN_INGEST_TOKEN: "a", ODIN_HOME: "/h", GITHUB_TOKEN: "b", GH_TOKEN: "c" });
  assert.deepEqual(Object.keys(env).sort(), ["ODIN_HOME", "PATH"]);
});
