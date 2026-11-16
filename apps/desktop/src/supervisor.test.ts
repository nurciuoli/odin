import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Clock, ProbeResult } from "./health.ts";
import { supervisor, type CoreChild } from "./supervisor.ts";

class FakeChild extends EventEmitter {
  stdout = null;
  stderr = null;
  sent: unknown[] = [];
  killed: (string | undefined)[] = [];
  exitOnShutdown = true;
  send(msg: unknown) {
    this.sent.push(msg);
    if (this.exitOnShutdown) queueMicrotask(() => this.emit("exit", 0, null));
    return true;
  }
  kill(signal?: NodeJS.Signals) {
    this.killed.push(signal);
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

function clock(): Clock & { t: number } {
  const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms, await Promise.resolve()) };
  return c;
}

const flush = () => new Promise((r) => setImmediate(r));
const log = { write() {}, line() {} };

test("restarts after an unexpected exit, then gives up", async () => {
  const children: FakeChild[] = [];
  let healthy = 0;
  let gaveUp = "";
  const s = supervisor({
    spawnCore: () => {
      const c = new FakeChild();
      children.push(c);
      return c as unknown as CoreChild;
    },
    check: async (): Promise<ProbeResult> => "odin",
    log,
    clock: clock(),
    onHealthy: () => healthy++,
    onGaveUp: (r) => (gaveUp = r),
  });
  await s.start();
  assert.equal(healthy, 1);
  for (let i = 0; i < 6; i++) {
    children.at(-1)!.emit("exit", 1, null);
    for (let j = 0; j < 10; j++) await flush();
  }
  assert.equal(children.length, 6); // first + 5 restarts
  assert.equal(healthy, 6);
  assert.match(gaveUp, /code 1/);
});

test("stop sends shutdown and does not restart", async () => {
  const c = new FakeChild();
  let spawned = 0;
  const s = supervisor({
    spawnCore: () => (spawned++, c as unknown as CoreChild),
    check: async () => "odin",
    log,
    clock: clock(),
    onHealthy() {},
    onGaveUp() {},
  });
  await s.start();
  await s.stop();
  await flush();
  assert.deepEqual(c.sent, [{ type: "shutdown" }]);
  assert.deepEqual(c.killed, []);
  assert.equal(spawned, 1);
});

test("stop kills after the timeout when core ignores shutdown", async () => {
  const c = new FakeChild();
  c.exitOnShutdown = false;
  const s = supervisor({
    spawnCore: () => c as unknown as CoreChild,
    check: async () => "odin",
    log,
    clock: clock(),
    onHealthy() {},
    onGaveUp() {},
  });
  await s.start();
  await s.stop();
  assert.deepEqual(c.killed, ["SIGKILL"]);
});
