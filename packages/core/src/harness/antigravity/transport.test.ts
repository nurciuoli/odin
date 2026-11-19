import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { attachAntigravity, antigravityBinary, scrubEnv, antigravityRpcError } from "./transport.ts";
import { setToolPathSource } from "../../tools/resolve.ts";

test("antigravityRpcError formats JSON-RPC error messages cleanly", () => {
  const err1 = antigravityRpcError({ code: -32600, message: "Invalid Request", data: "extra" });
  assert.equal(err1.message, "Invalid Request: extra (-32600)");

  const err2 = antigravityRpcError({ code: 500 });
  assert.equal(err2.message, "Antigravity request failed (500)");
});

test("scrubEnv removes token environment variables", () => {
  const env = scrubEnv({
    PATH: "C:\\bin",
    GITHUB_TOKEN: "secret1",
    GH_TOKEN: "secret2",
    ODIN_INGEST_TOKEN: "secret3",
    OTHER: "keep",
  });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.ODIN_INGEST_TOKEN, undefined);
  assert.equal(env.PATH, "C:\\bin");
  assert.equal(env.OTHER, "keep");
});

test("antigravityBinary respects tool override", () => {
  setToolPathSource(() => ({ antigravity: "C:\\custom\\agy.exe" }));
  try {
    const bin = antigravityBinary({}, "win32");
    assert.equal(bin, "C:\\custom\\agy.exe");
  } finally {
    setToolPathSource(null);
  }
});

test("attachAntigravity handles request/response matching and timeout", async () => {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();

  const rpc = attachAntigravity(child, 100);

  const reqPromise = rpc.request("initialize", { protocolVersion: 1 });
  // Simulate ACP server response
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } }) + "\n");
  const res = await reqPromise;
  assert.deepEqual(res, { protocolVersion: 1 });

  // The request timer is unref'd (it must not keep a real process alive), so hold the event loop open while
  // the test waits on it; otherwise node:test cancels this test and the ones after it.
  const hold = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      rpc.request("session/new", {}, 20),
      /Antigravity session\/new timed out/,
    );
  } finally {
    clearInterval(hold);
    rpc.close();
  }
});

test("attachAntigravity ignores non-object frames and a throwing event handler", async () => {
  const child = new EventEmitter() as any;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  const rpc = attachAntigravity(child, 100);
  const seen: unknown[] = [];
  rpc.onMessage = (m) => {
    seen.push(m);
    if (m.method === "boom") throw new Error("bad payload");
  };
  for (const frame of ["null", "5", "[1]", '"x"', "{not json", JSON.stringify({ method: "boom" }), JSON.stringify({ method: "ok" })]) child.stdout.write(`${frame}\n`);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.map((m: any) => m.method), ["boom", "ok"]);
  rpc.close();
});

test("attachAntigravity reports an unexpected exit and a dead stdin as failures", async () => {
  const exits: (Error | null)[] = [];
  const crashed = new EventEmitter() as any;
  crashed.stdin = new PassThrough();
  crashed.stdout = new PassThrough();
  const a = attachAntigravity(crashed, 100);
  a.onExit = (e) => exits.push(e);
  crashed.emit("close", 1);
  assert.equal(exits[0]?.message, "Antigravity exited (1)");

  const broken = new EventEmitter() as any;
  broken.stdin = new PassThrough();
  broken.stdout = new PassThrough();
  const b = attachAntigravity(broken, 100);
  b.onExit = (e) => exits.push(e);
  broken.stdin.emit("error", new Error("EPIPE"));
  assert.equal(exits[1]?.message, "Antigravity input closed");

  const quiet = new EventEmitter() as any;
  quiet.stdin = new PassThrough();
  quiet.stdout = new PassThrough();
  const c = attachAntigravity(quiet, 100);
  c.onExit = (e) => exits.push(e);
  c.close();
  quiet.emit("close", 0);
  assert.equal(exits.length, 2, "a deliberate close is not reported");
});
