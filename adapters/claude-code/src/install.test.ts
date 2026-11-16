import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOK_EVENTS, SETTINGS_RELATIVE_PATH, hooksInstalled, installHooks, removeHooks, settingsPath } from "./install.ts";

const SCRIPT = "/opt/odin/adapters/claude-code/src/odin-hook.ts";

function project(settings?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "odin-install-"));
  if (settings !== undefined) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(settingsPath(dir), typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
  }
  return dir;
}
const read = (dir: string) => JSON.parse(readFileSync(settingsPath(dir), "utf8"));

test("install creates the file with one hook per event", () => {
  const dir = project();
  try {
    assert.equal(hooksInstalled(dir), false);
    installHooks(dir, SCRIPT);
    assert.equal(hooksInstalled(dir), true);
    const s = read(dir);
    assert.deepEqual(Object.keys(s.hooks), [...HOOK_EVENTS]);
    assert.equal(s.hooks.Stop[0].hooks[0].command, `node "${SCRIPT}" Stop`);
    assert.equal(s.hooks.PostToolUse[0].matcher, "*");
    assert.equal(SETTINGS_RELATIVE_PATH, ".claude/settings.local.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a .cmd wrapper is run directly (no node), and replaces an earlier node .ts install", () => {
  const dir = project();
  try {
    installHooks(dir, SCRIPT);
    const cmd = "C:/Program Files/Odin/adapter/odin-hook.cmd";
    installHooks(dir, cmd);
    const s = read(dir);
    for (const event of HOOK_EVENTS) {
      const hooks = s.hooks[event].flatMap((g: any) => g.hooks);
      assert.deepEqual(hooks.map((h: any) => h.command), [`"${cmd}" ${event}`]);
    }
    assert.equal(hooksInstalled(dir), true);
    removeHooks(dir);
    assert.equal(existsSync(settingsPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("install and remove keep other keys and other hooks, and round-trip exactly", () => {
  const original = {
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo done" }] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./check.sh" }] }],
    },
  };
  const dir = project(original);
  try {
    installHooks(dir, SCRIPT);
    const s = read(dir);
    assert.deepEqual(s.permissions, original.permissions);
    assert.equal(s.hooks.Stop.length, 2);
    assert.equal(s.hooks.Stop[0].hooks[0].command, "echo done");
    assert.deepEqual(s.hooks.PreToolUse, original.hooks.PreToolUse);

    installHooks(dir, "/moved/odin-hook.ts"); // reinstall replaces, never duplicates
    assert.equal(read(dir).hooks.Stop.length, 2);
    assert.equal(read(dir).hooks.Stop[1].hooks[0].command, `node "/moved/odin-hook.ts" Stop`);

    removeHooks(dir);
    assert.equal(hooksInstalled(dir), false);
    assert.deepEqual(read(dir), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an older minerva-hook install is replaced and removed as an Odin hook", () => {
  const dir = project({
    hooks: { Stop: [{ hooks: [{ type: "command", command: 'node "C:/old/minerva-hook.ts" Stop' }] }] },
  });
  try {
    installHooks(dir, SCRIPT);
    assert.equal(hooksInstalled(dir), true);
    assert.equal(read(dir).hooks.Stop.length, 1);
    assert.equal(read(dir).hooks.Stop[0].hooks[0].command, `node "${SCRIPT}" Stop`);
    removeHooks(dir);
    assert.equal(existsSync(settingsPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Odin entry sharing a group with another hook leaves the other hook in place", () => {
  const dir = project({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }, { type: "command", command: `node "${SCRIPT}" Stop` }] }] },
  });
  try {
    removeHooks(dir);
    assert.deepEqual(read(dir), { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo hi" }] }] } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removing from a file Odin created deletes it; removing from nothing is a no-op", () => {
  const dir = project();
  try {
    removeHooks(dir);
    installHooks(dir, SCRIPT);
    removeHooks(dir);
    assert.equal(existsSync(settingsPath(dir)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid settings are never overwritten", () => {
  const dir = project("{ not json");
  try {
    assert.throws(() => installHooks(dir, SCRIPT), /not valid JSON/);
    assert.equal(readFileSync(settingsPath(dir), "utf8"), "{ not json");
    assert.equal(hooksInstalled(dir), false);
    assert.throws(() => removeHooks(dir), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
