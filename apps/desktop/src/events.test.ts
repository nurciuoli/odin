import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { eventClient, sseParser } from "./events.ts";
import { iconPng } from "./icons.ts";
import { isTrustedSender } from "./navigation.ts";

test("sseParser splits frames across chunks and skips non-data lines", () => {
  const got: string[] = [];
  const feed = sseParser((d) => got.push(d));
  feed("retry: 3000\n\nevent: heartbeat\ndata: {\"type\":\"heart");
  feed("beat\"}\n\n: comment\n\nevent: x\r\ndata: {\"type\":\"x\"}\r\n\r\n");
  assert.deepEqual(got, ['{"type":"heartbeat"}', '{"type":"x"}']);
});

test("eventClient calls onOpen on connect and again after the stream drops", async () => {
  const clients: ServerResponse[] = [];
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ type: "session.updated", n: clients.length })}\n\n`);
    clients.push(res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  let opens = 0;
  const events: unknown[] = [];
  const c = eventClient({ url: `http://127.0.0.1:${port}/api/events`, onOpen: () => opens++, onEvent: (e) => events.push(e) });
  try {
    c.start();
    while (events.length < 1) await new Promise((r) => setTimeout(r, 10));
    clients[0]!.destroy();
    while (events.length < 2) await new Promise((r) => setTimeout(r, 20));
    assert.equal(opens, 2);
    assert.deepEqual(events, [
      { type: "session.updated", n: 0 },
      { type: "session.updated", n: 1 },
    ]);
  } finally {
    c.stop();
    for (const r of clients) r.destroy();
    server.close();
  }
});

test("tray icons are PNGs, and the two variants differ", () => {
  const a = iconPng("normal", 16);
  const b = iconPng("needs-you", 16);
  assert.deepEqual([...a.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.notDeepEqual(a, b);
});

test("IPC accepts only the core origin's top frame", () => {
  const core = "http://127.0.0.1:8790";
  assert.equal(isTrustedSender({ url: `${core}/s/1`, isTop: true }, core), true);
  assert.equal(isTrustedSender({ url: `${core}/a/x/index.html`, isTop: false }, core), false);
  assert.equal(isTrustedSender({ url: "data:text/html,hi", isTop: true }, core), false);
  assert.equal(isTrustedSender({ url: "http://127.0.0.1:9999/", isTop: true }, core), false);
  assert.equal(isTrustedSender(null, core), false);
});
