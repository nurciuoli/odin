import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, type ProbeResult } from "./health.ts";
import { freePort, homeInstance, planPort, recordedPort } from "./ports.ts";

const probes = (map: Record<number, ProbeResult>) => async (port: number) => map[port] ?? "free";
const free = async () => 50123;

test("attaches to our core on the recorded port", async () => {
  assert.deepEqual(await planPort({ preferred: 8790, recorded: 8805, probe: probes({ 8805: "odin", 8790: "other" }), freePort: free }), {
    action: "attach",
    port: 8805,
    moved: true,
  });
});

test("a stale recorded port falls back to the preferred one", async () => {
  assert.deepEqual(await planPort({ preferred: 8790, recorded: 8805, probe: probes({ 8805: "free", 8790: "odin" }), freePort: free }), {
    action: "attach",
    port: 8790,
    moved: false,
  });
  assert.deepEqual(await planPort({ preferred: 8790, recorded: null, probe: probes({}), freePort: free }), {
    action: "spawn",
    port: 8790,
    moved: false,
  });
});

test("another program or another home's core on the preferred port moves us to a free one", async () => {
  for (const taken of ["other", "foreign"] as const) {
    assert.deepEqual(await planPort({ preferred: 8790, recorded: null, probe: probes({ 8790: taken }), freePort: free }), {
      action: "spawn",
      port: 50123,
      moved: true,
    });
  }
});

test("probe tells our core from another home's", async () => {
  const server = createServer((_req, res) => res.end(JSON.stringify({ ok: true, app: "odin", version: "x", instance: "theirs-123", now: "" })));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    assert.equal(await probe(port, { instance: "ours-12345" }), "foreign");
    assert.equal(await probe(port, { instance: "theirs-123" }), "odin");
    assert.equal(await probe(port), "odin");
  } finally {
    server.close();
  }
});

test("freePort returns a usable port; recordedPort and homeInstance read the home", async () => {
  const port = await freePort();
  assert.ok(port > 0 && port <= 65535);
  const home = mkdtempSync(join(tmpdir(), "odin-ports-"));
  try {
    assert.equal(recordedPort(home), null);
    writeFileSync(join(home, "runtime.json"), JSON.stringify({ port: 8811 }));
    assert.equal(recordedPort(home), 8811);
    const id = homeInstance(home);
    assert.equal(homeInstance(home), id);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
