import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { collectEvents, startApp } from "./test-helpers.ts";

/** fetch can't set Host, so this uses node:http. */
function statusWithHost(base: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/health`, { headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end();
  });
}

test("health, host check, 404s and SSE", async () => {
  const t = await startApp();
  try {
    const health = await t.json("/api/health");
    assert.deepEqual(Object.keys(health).sort(), ["app", "instance", "now", "ok", "version"]);
    assert.equal(health.ok, true);
    assert.equal(health.app, "odin");
    assert.equal(typeof health.version, "string");

    assert.equal(await statusWithHost(t.base, "evil.example"), 421);
    assert.equal(await statusWithHost(t.base, "localhost:5190"), 200);
    assert.equal(await statusWithHost(t.base, "mac.example.ts.net"), 421);

    const missing = await t.api("/api/nope");
    assert.equal(missing.status, 404);

    const cross = await t.api("/api/health", { method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(cross.status, 403);

    const events = await collectEvents(t.base, (e) => e.length >= 1);
    assert.equal(events[0]!.type, "heartbeat");
  } finally {
    await t.close();
  }
});

test("an extra host is accepted for Host and Origin, and other names are still refused", async () => {
  const t = await startApp({ config: { extraHosts: ["mac.example.ts.net"] } });
  try {
    assert.equal(await statusWithHost(t.base, "mac.example.ts.net"), 200);
    assert.equal(await statusWithHost(t.base, "evil.example"), 421);
    const allowed = await t.api("/api/health", { method: "POST", headers: { origin: "https://mac.example.ts.net" } });
    assert.notEqual(allowed.status, 403);
    const blocked = await t.api("/api/health", { method: "POST", headers: { origin: "https://evil.example" } });
    assert.equal(blocked.status, 403);
  } finally {
    await t.close();
  }
});

test("with an allowed login set, only that Tailscale login gets in; ingest and health stay open", async () => {
  const t = await startApp({ config: { allowedLogin: "me@example.com" } });
  try {
    assert.equal((await t.api("/api/health")).status, 200);
    assert.equal((await t.api("/api/projects")).status, 401);
    assert.equal((await t.api("/")).status, 401);
    assert.equal((await t.api("/api/events")).status, 401);
    assert.equal((await t.api("/api/projects", { headers: { "tailscale-user-login": "other@example.com" } })).status, 401);
    assert.equal((await t.api("/api/projects", { headers: { "tailscale-user-login": "Me@Example.com" } })).status, 200);
    // Ingest is judged by its own token, not the login.
    const ingest = await t.api("/api/ingest", { method: "POST", headers: { "content-type": "application/json" }, body: "[]" });
    assert.equal(ingest.status, 401);
    assert.match(await ingest.text(), /ingest token/);
  } finally {
    await t.close();
  }
});

test("schema applies: v2 tables exist, v1 tables don't", async () => {
  const { testDeps } = await import("./test-helpers.ts");
  const d = testDeps();
  const tables = new Set(d.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r: any) => r.name));
  for (const t of ["projects", "sessions", "session_events", "artifacts", "library_versions", "installations", "pulls", "gh_map"]) {
    assert.ok(tables.has(t), t);
  }
  for (const t of ["sprints", "topics", "actors", "agent_versions", "items", "milestones", "session_items", "work_items", "work_leases", "work_inbox"]) assert.ok(!tables.has(t), t);
  const sessionColumns = d.db.prepare("SELECT name FROM pragma_table_info('sessions')").all().map((r: any) => r.name);
  assert.ok(!sessionColumns.includes("item_id"));
});
