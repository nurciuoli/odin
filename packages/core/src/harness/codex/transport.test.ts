import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { attachCodex, codexCommand } from "./transport.ts";
import { setToolPathSource } from "../../tools/resolve.ts";

test("codexCommand: a Settings override wins over the PATH search, but not inside WSL", () => {
  setToolPathSource(() => ({ codex: "/opt/codex/codex" }));
  try {
    assert.deepEqual(codexCommand(false, { PATH: "" }, "linux"), { command: "/opt/codex/codex", args: ["app-server"] });
    assert.equal(codexCommand(true).command, "wsl.exe");
  } finally {
    setToolPathSource(null);
  }
  assert.equal(codexCommand(false, { PATH: "" }, "linux").command, "codex");
});

function processFixture(timeout = 1000) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true;
    },
  });
  const rpc = attachCodex(
    child as unknown as ChildProcessWithoutNullStreams,
    timeout,
  );
  return { child, rpc };
}

test("JSONL transport correlates concurrent responses, fragmented frames and native notifications", async () => {
  const { child, rpc } = processFixture();
  const notifications: unknown[] = [];
  rpc.onMessage = (message) => notifications.push(message);
  try {
    const one = rpc.request("one");
    const two = rpc.request("two");
    child.stdout.write('{"id":2,"res');
    child.stdout.write(
      'ult":{"ok":true}}\n{"method":"turn/completed","params":{}}\n',
    );
    child.stdout.write('{"id":1,"result":{"name":"first"}}\n');
    assert.deepEqual(await two, { ok: true });
    assert.deepEqual(await one, { name: "first" });
    assert.equal(notifications.length, 1);
    const failed = rpc.request("bad");
    child.stdout.write('{"id":3,"error":{"code":-32600,"message":"SECRET"}}\n');
    await assert.rejects(
      failed,
      (error) =>
        error instanceof Error &&
        !error.message.includes("SECRET") &&
        error.message.includes("-32600"),
    );
  } finally {
    rpc.close();
  }
});

test("transport closes pending requests exactly once on crash and rejects malformed JSON", async () => {
  for (const invalid of [false, true]) {
    const { child, rpc } = processFixture();
    let exits = 0;
    rpc.onExit = () => exits++;
    const pending = rpc.request("waiting");
    if (invalid) child.stdout.write("not JSON\n");
    else child.emit("exit", 1);
    await assert.rejects(pending);
    rpc.close();
    assert.equal(exits, 1);
    await assert.rejects(rpc.request("after-close"), /closed/);
  }
});

test("WSL launches with argv and selects the UNC project's distribution", () => {
  assert.deepEqual(
    codexCommand(
      true,
      {},
      "win32",
      "\\\\wsl.localhost\\Ubuntu Dev\\home\\alex\\repo",
    ),
    {
      command: "wsl.exe",
      args: ["--distribution", "Ubuntu Dev", "--exec", "codex", "app-server"],
    },
  );
});
