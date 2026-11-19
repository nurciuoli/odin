import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessInfo } from "@odin/shared/api";
import { claudeLoginPresent, readiness, type ReadinessInput } from "./readiness.ts";
import { startApp, tempDir, removeTempDir } from "../test-helpers.ts";

const claude = (available: boolean): HarnessInfo => ({ id: "claude", name: "Claude Code", available, note: available ? null : "no binary" });

const ready: ReadinessInput = {
  harnesses: [claude(true)],
  gitVersion: "git version 2.47.0",
  github: { configured: true, source: "gh" },
  ghFound: true,
  claudeLogin: true,
  projectCount: 2,
};

const state = (r: ReturnType<typeof readiness>, id: string) => r.checks.find((c) => c.id === id)?.state;

test("a set-up machine is ready with every check ok", () => {
  const r = readiness(ready);
  assert.equal(r.ready, true);
  assert.deepEqual(r.checks.map((c) => [c.id, c.state]), [
    ["harness", "ok"],
    ["claude-auth", "ok"],
    ["git", "ok"],
    ["github", "ok"],
    ["projects", "ok"],
  ]);
  assert.ok(r.checks.every((c) => c.fix === null));
});

test("no runtime or no git blocks; login, GitHub and projects only advise", () => {
  const blank = readiness({ harnesses: [claude(false)], gitVersion: null, github: { configured: false, source: null }, ghFound: false, claudeLogin: false, projectCount: 0 });
  assert.equal(blank.ready, false);
  assert.equal(state(blank, "harness"), "missing");
  assert.match(blank.checks[0]!.detail, /no binary/);
  assert.equal(state(blank, "claude-auth"), undefined, "no login check without Claude");
  assert.equal(state(blank, "git"), "missing");
  assert.equal(state(blank, "github"), "optional");
  assert.equal(state(blank, "projects"), "todo");

  const noLogin = readiness({ ...ready, claudeLogin: null, github: { configured: false, source: null }, projectCount: 0 });
  assert.equal(noLogin.ready, true);
  assert.equal(state(noLogin, "claude-auth"), "warn");
  assert.match(noLogin.checks.find((c) => c.id === "github")!.fix!, /gh auth login/);
});

test("claudeLoginPresent looks at env names and the credentials file, never values", () => {
  const home = tempDir("odin-ready-");
  try {
    assert.equal(claudeLoginPresent({}, home, "win32"), false);
    assert.equal(claudeLoginPresent({}, home, "darwin"), null);
    assert.equal(claudeLoginPresent({ ANTHROPIC_API_KEY: "x" }, home, "linux"), true);
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", ".credentials.json"), "{}");
    assert.equal(claudeLoginPresent({}, home, "win32"), true);
    assert.equal(claudeLoginPresent({ CLAUDE_CONFIG_DIR: join(home, "elsewhere") }, home, "win32"), false);
  } finally {
    removeTempDir(home);
  }
});

test("GET /api/readiness reports the fake runtime and no projects", async () => {
  const dir = tempDir("odin-ready-cfg-");
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const t = await startApp();
  try {
    const r = await t.json("/api/readiness");
    assert.equal(typeof r.ready, "boolean");
    assert.deepEqual(r.checks.map((c: { id: string }) => c.id).filter((id: string) => id !== "claude-auth"), ["harness", "git", "github", "projects"]);
    assert.equal(r.checks.find((c: { id: string }) => c.id === "projects").state, "todo");
  } finally {
    await t.close();
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    removeTempDir(dir);
  }
});
