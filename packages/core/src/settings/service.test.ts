import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_PRICING } from "@odin/shared/pricing";
import type { SettingsResponse } from "@odin/shared/api";
import { routeApp } from "../ingest/fakes.ts";
import { fakeHarness } from "../harness/fake.ts";
import type { Services } from "../services.ts";
import { stubServices, testDeps } from "../test-helpers.ts";
import { registerSettingsRoutes } from "./routes.ts";
import { DEFAULT_APP_SETTINGS, createSettingsService } from "./service.ts";

const make = (over = {}) => {
  const deps = testDeps(over);
  return { deps, settings: createSettingsService(deps, stubServices({})) };
};

test("settings default, round trip through app_settings, and survive a new service over the same db", () => {
  const { deps, settings } = make();
  assert.deepEqual(settings.get(), DEFAULT_APP_SETTINGS);
  const next = settings.update({ defaultModel: "opus", defaultWorktree: true });
  assert.deepEqual(next, { ...DEFAULT_APP_SETTINGS, defaultModel: "opus", defaultWorktree: true });
  assert.deepEqual(createSettingsService(deps, stubServices({})).get(), next);
  assert.equal(settings.update({ defaultModel: null }).defaultModel, null);
  assert.equal(settings.update({ notifyOnWaiting: false, defaultPermissionMode: "plan" }).defaultPermissionMode, "plan");
});

test("invalid values are rejected and nothing is written", () => {
  const { settings } = make();
  assert.throws(() => settings.update({ defaultWorktree: true, defaultPermissionMode: "nope" as never }), /defaultPermissionMode/);
  assert.throws(() => settings.update({ notifyOnWaiting: "yes" as never }), /notifyOnWaiting/);
  assert.throws(() => settings.update({ bogus: 1 } as never), /unknown setting/);
  assert.deepEqual(settings.get(), DEFAULT_APP_SETTINGS);
});

test("desktop settings: defaults, validation, toolPaths restricted to known tools with absolute paths", () => {
  const { settings } = make();
  const d = settings.get();
  assert.equal(d.notifyOnFinished, true);
  assert.equal(d.launcherShortcut, "CommandOrControl+Shift+Space");
  assert.equal(d.editorCommand, "code");
  assert.deepEqual(d.toolPaths, {});
  const abs = process.platform === "win32" ? "C:\\tools\\gh.exe" : "/usr/local/bin/gh";
  const next = settings.update({ notifyOnFinished: false, launcherShortcut: null, editorCommand: " cursor ", toolPaths: { gh: abs, git: "" } });
  assert.equal(next.notifyOnFinished, false);
  assert.equal(next.launcherShortcut, null);
  assert.equal(next.editorCommand, "cursor");
  assert.deepEqual(next.toolPaths, { gh: abs });
  assert.throws(() => settings.update({ toolPaths: { node: abs } as never }), /toolPaths/);
  assert.throws(() => settings.update({ toolPaths: { gh: "relative/gh" } }), /toolPaths/);
  assert.throws(() => settings.update({ toolPaths: { gh: 3 } as never }), /toolPaths/);
  assert.throws(() => settings.update({ editorCommand: "" }), /editorCommand/);
  assert.throws(() => settings.update({ editorCommand: "x".repeat(201) }), /editorCommand/);
  assert.throws(() => settings.update({ launcherShortcut: "x".repeat(101) }), /launcherShortcut/);
  assert.throws(() => settings.update({ notifyOnFinished: 1 as never }), /notifyOnFinished/);
  assert.deepEqual(settings.get().toolPaths, { gh: abs });
});

test("pricing: defaults without a file; savePricing writes pretty JSON and is read back", () => {
  const { deps, settings } = make();
  assert.deepEqual(settings.pricing(), DEFAULT_PRICING);
  settings.savePricing({ "anthropic/Custom-1": { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } });
  const text = readFileSync(deps.config.pricingPath, "utf8");
  assert.ok(text.includes('\n  "custom-1": {\n    "input": 1,'), text);
  assert.deepEqual(settings.pricing()["custom-1"], { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 });
  assert.deepEqual(settings.pricing()["claude-sonnet-5-5"], DEFAULT_PRICING["claude-sonnet-5-5"]);
  // An edit by hand is picked up too.
  writeFileSync(deps.config.pricingPath, JSON.stringify({ "claude-sonnet-5-5": { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 } }));
  assert.equal(settings.pricing()["claude-sonnet-5-5"]!.input, 9);
});

test("savePricing rejects bad prices without touching the file", () => {
  const { deps, settings } = make();
  assert.throws(() => settings.savePricing({ x: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }), /price/);
  assert.throws(() => settings.savePricing({ x: { input: 1 } as never }), /price/);
  assert.equal(existsSync(deps.config.pricingPath), false);
});

async function routes(deps = testDeps()) {
  const settings = createSettingsService(deps, stubServices({}));
  const services = stubServices({ settings, library: { root: "/lib" } as unknown as Services["library"] });
  const a = await routeApp(registerSettingsRoutes, deps, services);
  return { ...a, deps };
}

test("GET /api/settings reports settings, pricing, GitHub status (never the token), harnesses and the library path", async () => {
  const deps = testDeps({ harnesses: { claude: fakeHarness({ available: false }) } });
  deps.config.githubToken = "ghp_secret";
  deps.config.githubTokenSource = "gh";
  const a = await routes(deps);
  try {
    const text = await (await a.fetch("/api/settings")).text();
    assert.ok(!text.includes("ghp_secret"));
    const body = JSON.parse(text) as SettingsResponse;
    assert.deepEqual(body.settings, DEFAULT_APP_SETTINGS);
    assert.deepEqual(body.pricing, DEFAULT_PRICING);
    assert.deepEqual(body.github, { configured: true, source: "gh" });
    assert.equal(body.libraryPath, "/lib");
    assert.equal(body.harnesses.length, 1);
    assert.equal(body.harnesses[0]!.id, "claude");
    assert.equal(body.harnesses[0]!.available, false);
  } finally {
    await a.close();
  }
});

test("GET /api/settings without a token says not configured; a harness whose check throws is unavailable", async () => {
  const bad = { ...fakeHarness(), check: async () => { throw new Error("no cli"); } };
  const a = await routes(testDeps({ harnesses: { claude: bad } }));
  try {
    const body = (await (await a.fetch("/api/settings")).json()) as SettingsResponse;
    assert.deepEqual(body.github, { configured: false, source: null });
    assert.deepEqual([body.harnesses[0]!.available, body.harnesses[0]!.note], [false, "no cli"]);
  } finally {
    await a.close();
  }
});

test("PATCH /api/settings updates settings and replaces pricing; bad input is a 400 that changes nothing", async () => {
  const a = await routes();
  try {
    const patch = (body: unknown) => a.fetch("/api/settings", { method: "PATCH", body: JSON.stringify(body) });
    const ok = await patch({ settings: { defaultWorktree: true }, pricing: { "my-model": { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } });
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as SettingsResponse;
    assert.equal(body.settings.defaultWorktree, true);
    assert.deepEqual(body.pricing["my-model"], { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 });

    assert.equal((await patch({ settings: { defaultWorktree: "x" } })).status, 400);
    assert.equal((await patch({ settings: { notifyOnWaiting: false }, pricing: { bad: { input: -1 } } })).status, 400);
    assert.equal((await patch([])).status, 400);
    const after = (await (await a.fetch("/api/settings")).json()) as SettingsResponse;
    assert.equal(after.settings.notifyOnWaiting, true);
  } finally {
    await a.close();
  }
});
