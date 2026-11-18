import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SecretInfo, SecretsResponse } from "@odin/shared/api";
import { startApp } from "../test-helpers.ts";

const homes: string[] = [];
after(() => homes.forEach((h) => rmSync(dirname(h), { recursive: true, force: true })));

async function app() {
  const t = await startApp();
  homes.push(t.config.home);
  return t;
}
const put = (t: Awaited<ReturnType<typeof app>>, name: string, body: unknown) => t.api(`/api/secrets/${name}`, { method: "PUT", body: JSON.stringify(body) });

test("secrets: put, list without values, replace keeps createdAt, delete", async () => {
  const t = await app();
  try {
    const first = await put(t, "GH_TOKEN", { value: "ghp_secret" });
    assert.equal(first.status, 200);
    const info = (await first.json()) as SecretInfo;
    assert.deepEqual(Object.keys(info).sort(), ["createdAt", "name", "updatedAt", "usedBy"]);
    assert.equal(JSON.stringify(info).includes("ghp_secret"), false);

    await put(t, "GH_TOKEN", { value: "ghp_other" });
    const list = await t.json<SecretsResponse>("/api/secrets");
    assert.deepEqual(list.secrets.map((s) => s.name), ["GH_TOKEN"]);
    assert.equal(list.secrets[0]!.createdAt, info.createdAt);
    assert.equal(JSON.stringify(list).includes("ghp_"), false);

    assert.equal((await t.api("/api/secrets/GH_TOKEN", { method: "DELETE" })).status, 204);
    assert.equal((await t.api("/api/secrets/GH_TOKEN", { method: "DELETE" })).status, 404);
  } finally {
    await t.close();
  }
});

test("secrets: bad names and values are rejected and nothing is written", async () => {
  const t = await app();
  try {
    assert.equal((await put(t, "1bad", { value: "x" })).status, 400);
    assert.equal((await put(t, "ok", { value: "" })).status, 400);
    assert.equal((await put(t, "ok", { value: "a\nb" })).status, 400);
    assert.equal((await put(t, "ok", { value: "x".repeat(16 * 1024 + 1) })).status, 400);
    assert.equal((await put(t, "ok", { value: 5 })).status, 400);
    assert.deepEqual((await t.json<SecretsResponse>("/api/secrets")).secrets, []);
  } finally {
    await t.close();
  }
});

test("secrets: stored in <home>/secrets.json with mode 600", async () => {
  const t = await app();
  try {
    await put(t, "K", { value: "v" });
    const file = join(t.config.home, "secrets.json");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).secrets.K.value, "v");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    await t.close();
  }
});

test("secrets: a corrupt store is a 500 that does not echo its content", async () => {
  const t = await app();
  try {
    await put(t, "K", { value: "v" });
    writeFileSync(join(t.config.home, "secrets.json"), "{not json sk-live-123");
    const res = await t.api("/api/secrets");
    assert.equal(res.status, 500);
    assert.equal((await res.text()).includes("sk-live-123"), false);
  } finally {
    await t.close();
  }
});

test("secrets: list shows which MCP specs use a secret and which are missing", async () => {
  const t = await app();
  try {
    const spec = { type: "http", url: "https://x.test/mcp", headers: { Authorization: "Bearer ${secret:TOK}" } };
    const saved = await t.api("/api/library/mcp/web", { method: "PUT", body: JSON.stringify({ files: { "web.json": JSON.stringify(spec) } }) });
    assert.equal(saved.status, 201);
    let list = await t.json<SecretsResponse>("/api/secrets");
    assert.deepEqual(list.missing, [{ name: "TOK", usedBy: ["web"] }]);
    await put(t, "TOK", { value: "v" });
    list = await t.json<SecretsResponse>("/api/secrets");
    assert.deepEqual([list.missing, list.secrets[0]!.usedBy], [[], ["web"]]);
    const bad = await t.api("/api/library/mcp/oops", { method: "PUT", body: JSON.stringify({ files: { "oops.json": JSON.stringify({ command: "x", env: { A: "${secret:no good}" } }) } }) });
    assert.equal(bad.status, 400);
  } finally {
    await t.close();
  }
});
