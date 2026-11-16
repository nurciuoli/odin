import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { decide, probe, waitForHealth, type Clock, type ProbeResult } from "./health.ts";

function serve(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port }));
  });
}

test("attaches to a Odin core", async () => {
  const { server, port } = await serve((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, app: "odin", version: "0.1.0", now: new Date().toISOString() }));
  });
  try {
    assert.equal(decide(await probe(port)), "attach");
  } finally {
    server.close();
  }
});

test("a 200 from another service is port-taken", async () => {
  const { server, port } = await serve((_req, res) => res.end(JSON.stringify({ ok: true })));
  try {
    assert.equal(decide(await probe(port)), "port-taken");
  } finally {
    server.close();
  }
});

test("non-JSON is port-taken", async () => {
  const { server, port } = await serve((_req, res) => res.end("<html>"));
  try {
    assert.equal(await probe(port), "other");
  } finally {
    server.close();
  }
});

test("a closed port means spawn", async () => {
  const { server, port } = await serve((_req, res) => res.end());
  await new Promise((r) => server.close(r));
  assert.equal(decide(await probe(port)), "spawn");
});

function fakeClock(): Clock & { t: number } {
  const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
  return c;
}

test("waitForHealth resolves once core answers", async () => {
  const answers: ProbeResult[] = ["free", "free", "odin"];
  const clock = fakeClock();
  assert.equal(await waitForHealth(async () => answers.shift() ?? "free", { clock }), true);
  assert.equal(clock.t, 500);
});

test("waitForHealth gives up after the timeout", async () => {
  const clock = fakeClock();
  assert.equal(await waitForHealth(async () => "free", { clock, timeoutMs: 20_000 }), false);
  assert.ok(clock.t <= 20_000 && clock.t >= 19_750);
});
