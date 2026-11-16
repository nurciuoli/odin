import { test } from "node:test";
import assert from "node:assert/strict";
import { INGEST_MAX_BATCH } from "@odin/shared/ingest";
import { INGEST_TOKEN, testDeps } from "../test-helpers.ts";
import { fakeSessions, ingestServices, routeApp } from "./fakes.ts";
import { registerIngestRoutes } from "./routes.ts";

async function app() {
  const deps = testDeps();
  const sessions = fakeSessions(deps.db);
  const a = await routeApp(registerIngestRoutes, deps, ingestServices(deps, sessions));
  const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${INGEST_TOKEN}` }) =>
    a.fetch("/api/ingest", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { ...a, post, sessions };
}

const event = (id: string) => ({ id, ts: "2026-10-17T12:00:00Z", harness: "claude-code", session: "s1", cwd: "/work/demo", kind: "turn", data: { index: 1, durationMs: 10 } });

test("POST /api/ingest needs the bearer token", async () => {
  const a = await app();
  try {
    assert.equal((await a.post(event("a"), {})).status, 401);
    assert.equal((await a.post(event("a"), { authorization: "Bearer wrong" })).status, 401);
    assert.equal(a.sessions.records.size, 0);
  } finally {
    await a.close();
  }
});

test("POST /api/ingest takes one event or an array and answers with an IngestResponse", async () => {
  const a = await app();
  try {
    const one = await a.post(event("a"));
    assert.deepEqual(await one.json(), { accepted: 1, duplicates: 0, rejected: [], sessionIds: ["s1"] });
    const many = await (await a.post([event("a"), event("b"), { id: "c" }])).json();
    assert.deepEqual([many.accepted, many.duplicates, many.rejected.length], [1, 1, 1]);
  } finally {
    await a.close();
  }
});

test("POST /api/ingest: 413 over 1 MB, 400 over the batch limit or for bad JSON", async () => {
  const a = await app();
  try {
    assert.equal((await a.post({ pad: "x".repeat(1024 * 1024 + 10) })).status, 413);
    assert.equal((await a.post(Array.from({ length: INGEST_MAX_BATCH + 1 }, (_, i) => event(`n${i}`)))).status, 400);
    assert.equal((await a.post("{nope")).status, 400);
  } finally {
    await a.close();
  }
});
