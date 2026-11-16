import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, connect, type Socket } from "node:net";
import { test, type TestContext } from "node:test";
import { startHostBridge } from "./bridge.ts";
import { parentClient } from "./host-mcp.ts";

async function peer(t: TestContext, handle: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket)); handle(socket); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return address.port;
}

test("host bridge client rejects pending and future calls after disconnect", async t => {
  const port = await peer(t, socket => socket.once("data", () => socket.destroy()));
  const parent = parentClient(port); t.after(() => parent.close());
  await assert.rejects(parent({ id: 1, method: "tools/list" }), /closed|failed/);
  await assert.rejects(parent({ id: 2, method: "tools/list" }), /closed|failed/);
});

test("host bridge client rejects a request when its peer never answers", async t => {
  const port = await peer(t, () => {});
  const parent = parentClient(port, 50); t.after(() => parent.close());
  await assert.rejects(parent({ id: 1, method: "tools/list" }), /timed out/);
});

for (const [name, payload, expected] of [
  ["malformed JSON", "bad-json\n", /Invalid/],
  ["invalid shape", "null\n", /Invalid/],
  ["oversized frame", "x".repeat(257), /too large/],
] as const) test("host bridge client refuses " + name, async t => {
  const port = await peer(t, socket => socket.once("data", () => socket.write(payload)));
  const parent = parentClient(port, 1000, 256); t.after(() => parent.close());
  await assert.rejects(parent({ id: 1, method: "tools/list" }), expected);
});

test("host bridge handles utf8 chunks and correlates tool replies", async t => {
  const bridge = await startHostBridge([{ name: "echo", description: "Echo", params: {}, handler: async () => ({ text: "raven ??" }) }]);
  t.after(() => bridge.close());
  const parent = parentClient(bridge.port); t.after(() => parent.close());
  const answer = await parent({ id: 1, method: "tools/call", params: { name: "echo" } });
  assert.deepEqual(answer.result, { text: "raven ??" });
});

test("host bridge drops oversized unterminated client frames", async t => {
  const bridge = await startHostBridge([], 128); t.after(() => bridge.close());
  const socket = connect({ port: bridge.port, host: "127.0.0.1" });
  socket.on("error", () => {}); t.after(() => socket.destroy());
  await once(socket, "connect");
  const closed = once(socket, "close");
  socket.write("x".repeat(129));
  await closed;
});

test("host bridge safely discards a tool result after its client disconnects", async t => {
  let complete!: () => void;
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const waiting = new Promise<void>(resolve => { complete = resolve; });
  const bridge = await startHostBridge([{ name: "slow", description: "Slow", params: {}, handler: async () => { began(); await waiting; return { text: "done" }; } }]);
  t.after(() => bridge.close());
  const parent = parentClient(bridge.port); t.after(() => parent.close());
  const result = parent({ id: 1, method: "tools/call", params: { name: "slow" } });
  const rejected = assert.rejects(result, /closed/);
  await started; parent.close(); complete(); await rejected;
  await new Promise(resolve => setImmediate(resolve));
});
