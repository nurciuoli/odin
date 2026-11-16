import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { installShutdownHandlers, isShutdownMessage } from "./shutdown.ts";

function fakeProcess(ipc: boolean) {
  const proc = new EventEmitter() as EventEmitter & { send?: () => void };
  if (ipc) proc.send = () => {};
  const calls = { close: 0, exits: [] as number[] };
  let release!: () => void;
  const closed = new Promise<void>((r) => (release = r));
  installShutdownHandlers(proc, async () => {
    calls.close++;
    await closed;
  }, (code) => calls.exits.push(code));
  return { proc, calls, release };
}

const tick = () => new Promise((r) => setImmediate(r));

test("shutdown: IPC { type: \"shutdown\" } closes once, then exits 0", async () => {
  const { proc, calls, release } = fakeProcess(true);
  proc.emit("message", { type: "other" });
  proc.emit("message", "shutdown");
  assert.equal(calls.close, 0);
  proc.emit("message", { type: "shutdown" });
  proc.emit("message", { type: "shutdown" });
  proc.emit("SIGTERM");
  assert.equal(calls.close, 1);
  await tick();
  assert.deepEqual(calls.exits, [], "waits for close before exiting");
  release();
  await tick();
  assert.deepEqual(calls.exits, [0]);
});

test("shutdown: IPC disconnect does nothing", async () => {
  const { proc, calls } = fakeProcess(true);
  proc.emit("disconnect");
  await tick();
  assert.equal(calls.close, 0);
  assert.deepEqual(calls.exits, []);
});

test("shutdown: SIGTERM runs the same close; no IPC channel means messages are not listened to", async () => {
  const { proc, calls, release } = fakeProcess(false);
  assert.equal(proc.listenerCount("message"), 0);
  proc.emit("SIGTERM");
  release();
  await tick();
  assert.equal(calls.close, 1);
  assert.deepEqual(calls.exits, [0]);
});

test("shutdown: a failing close still exits 0", async () => {
  const proc = new EventEmitter() as EventEmitter & { send?: () => void };
  proc.send = () => {};
  const exits: number[] = [];
  installShutdownHandlers(proc, () => Promise.reject(new Error("boom")), (c) => exits.push(c));
  proc.emit("message", { type: "shutdown" });
  await tick();
  assert.deepEqual(exits, [0]);
  assert.equal(isShutdownMessage(null), false);
});
