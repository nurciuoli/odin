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

  // Test timeout
  await assert.rejects(
    rpc.request("session/new", {}, 20),
    /Antigravity session\/new timed out/,
  );

  rpc.close();
});
