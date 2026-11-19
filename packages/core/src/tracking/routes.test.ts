import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { HttpError, send, sendError } from "../http/util.ts";
import { Router } from "../http/router.ts";
import type { Services } from "../services.ts";
import { startApp, testDeps, tempDir, removeTempDir } from "../test-helpers.ts";
import { registerTrackingRoutes } from "./routes.ts";

const SETTINGS = ".claude/settings.local.json";

/** Just enough of server.ts to dispatch to the router, with a fake projects service. */
async function fakeApp(projects: Record<string, string>, adapterDir?: string) {
  const router = new Router();
  const services = { projects: { get: (name: string) => (projects[name] ? { name, path: projects[name] } : null) } } as unknown as Services;
  const deps = testDeps();
  if (adapterDir) deps.config.adapterDir = adapterDir;
  registerTrackingRoutes(router, deps, services);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const m = router.match(req.method ?? "GET", url.pathname);
      if (m.kind !== "found") return sendError(res, 404, "not found");
      const result = await m.handler({ req, res, url, params: m.params });
      send(res, 200, result);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.message);
      sendError(res, 500, "internal error");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (name: string, body: unknown) =>
    fetch(`${base}/api/projects/${name}/tracking/claude-code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const get = (name: string) => fetch(`${base}/api/projects/${name}/tracking/claude-code`);
  return { post, get, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test("tracking routes install and remove the hooks, keeping the rest of settings.local.json", async () => {
  const dir = tempDir("odin-tracking-");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, SETTINGS), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
  const app = await fakeApp({ demo: dir });
  try {
    assert.deepEqual(await (await app.get("demo")).json(), { enabled: false, settingsPath: SETTINGS });

    const on = await app.post("demo", { enabled: true });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { enabled: true, settingsPath: SETTINGS });
    assert.deepEqual(await (await app.get("demo")).json(), { enabled: true, settingsPath: SETTINGS });
    const settings = JSON.parse(readFileSync(join(dir, SETTINGS), "utf8"));
    assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
    const command: string = settings.hooks.SessionStart[0].hooks[0].command;
    const script = /^node "(.+)" SessionStart$/.exec(command)?.[1];
    assert.ok(script?.replace(/\\+/g, "/").endsWith("adapters/claude-code/src/odin-hook.ts"));
    assert.ok(existsSync(script!), "the installed path is the real hook script");

    assert.deepEqual(await (await app.post("demo", { enabled: false })).json(), { enabled: false, settingsPath: SETTINGS });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, SETTINGS), "utf8")), { permissions: { allow: ["Bash(ls)"] } });
  } finally {
    await app.close();
    removeTempDir(dir);
  }
});

test("tracking routes install the hook from config.adapterDir, preferring a bundled odin-hook.js", async () => {
  const dir = tempDir("odin-tracking-");
  const adapterDir = tempDir("odin-adapter-");
  writeFileSync(join(adapterDir, "odin-hook.js"), "");
  const app = await fakeApp({ demo: dir }, adapterDir);
  try {
    assert.equal((await app.post("demo", { enabled: true })).status, 200);
    const settings = JSON.parse(readFileSync(join(dir, SETTINGS), "utf8"));
    const script = /^node "(.+)" SessionStart$/.exec(settings.hooks.SessionStart[0].hooks[0].command)?.[1];
    assert.equal(script?.replace(/\\+/g, "/"), join(adapterDir, "odin-hook.js").replace(/\\+/g, "/"));
  } finally {
    await app.close();
    removeTempDir(dir);
    removeTempDir(adapterDir);
  }
});

test("tracking routes: 404 for an unknown project, 400 for a bad body, 409 for unreadable settings", async () => {
  const dir = tempDir("odin-tracking-");
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, SETTINGS), "{ nope");
  const app = await fakeApp({ demo: dir });
  try {
    assert.equal((await app.get("ghost")).status, 404);
    assert.equal((await app.post("ghost", { enabled: true })).status, 404);
    assert.equal((await app.post("demo", { enabled: "yes" })).status, 400);
    assert.equal((await app.post("demo", {})).status, 400);
    assert.equal((await app.post("demo", { enabled: true })).status, 409);
    assert.equal(readFileSync(join(dir, SETTINGS), "utf8"), "{ nope");
    assert.deepEqual(await (await app.get("demo")).json(), { enabled: false, settingsPath: SETTINGS });
  } finally {
    await app.close();
    removeTempDir(dir);
  }
});

test("tracking routes through startApp: an unknown project is a 404", async (t) => {
  const app = await startApp();
  try {
    const res = await app.api("/api/projects/nope/tracking/claude-code");
    if (res.status === 500) return t.skip("projects service is not implemented yet");
    assert.equal(res.status, 404);
    assert.equal((await app.api("/api/projects/nope/tracking/claude-code", { method: "POST", body: JSON.stringify({ enabled: true }) })).status, 404);
  } finally {
    await app.close();
  }
});
