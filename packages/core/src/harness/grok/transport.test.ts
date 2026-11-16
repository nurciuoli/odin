import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { attachGrok } from "./transport.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { grokBinary, grokCommand, grokRpcError, scrubEnv } from "./transport.ts";
import { setToolPathSource } from "../../tools/resolve.ts";

test("grokBinary: a Settings override wins over the PATH search", () => {
  setToolPathSource(() => ({ grok: "/opt/grok/grok" }));
  try {
    assert.equal(grokBinary({ PATH: "" }, "linux"), "/opt/grok/grok");
  } finally {
    setToolPathSource(null);
  }
  assert.equal(grokBinary({ PATH: "" }, "linux"), null);
});

test("RPC errors keep the code and the reason", () => {
  assert.equal(grokRpcError({ code: -32602, message: "Invalid params", data: "unknown model id" }).message, "Invalid params: unknown model id (-32602)");
  assert.equal(grokRpcError({}).message, "Grok request failed (unknown)");
});

test("grok argv is the ACP stdio agent and secrets are stripped", () => {
  const spec = grokCommand({ PATH: process.env.PATH, GITHUB_TOKEN: "nope", XAI_API_KEY: "keep" }, process.platform);
  if (spec) assert.deepEqual(spec.args, ["--no-auto-update", "agent", "--no-leader", "stdio"]);
  else assert.equal(grokBinary({ PATH: "" }, "linux"), null);
  const env = scrubEnv({ PATH: "x", GITHUB_TOKEN: "a", GH_TOKEN: "b", ODIN_INGEST_TOKEN: "c", XAI_API_KEY: "d" });
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.ODIN_INGEST_TOKEN, undefined);
  assert.equal(env.XAI_API_KEY, "d");
});


for (const payload of ["null", "[]", "42"]) test("Grok transport closes on non-object frame " + payload, () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    killed: false, kill() { this.killed = true; return true; },
  });
  const rpc = attachGrok(child as unknown as ChildProcessWithoutNullStreams);
  let failure: Error | null = null;
  rpc.onExit = error => { failure = error; };
  assert.doesNotThrow(() => child.stdout.write(payload + "\n"));
  assert.equal(child.killed, true);
  assert.match(String(failure), /Invalid Grok protocol message/);
});
