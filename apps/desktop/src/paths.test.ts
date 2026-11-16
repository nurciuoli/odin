import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOpenPath, isInside } from "./paths.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "odin-paths-"));
  const project = join(base, "project");
  const outside = join(base, "outside");
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, "src", "a.ts"), "");
  writeFileSync(join(outside, "secret.txt"), "");
  return { base, project, outside, done: () => rmSync(base, { recursive: true, force: true }) };
}

test("accepts the project root and paths under it", async () => {
  const f = fixture();
  try {
    assert.ok(await checkOpenPath(f.project, [f.project]));
    assert.ok((await checkOpenPath(join(f.project, "src", "a.ts"), [f.project])).endsWith("a.ts"));
  } finally {
    f.done();
  }
});

test("refuses paths outside every root, relative paths, missing paths and junk", async () => {
  const f = fixture();
  try {
    await assert.rejects(checkOpenPath(join(f.outside, "secret.txt"), [f.project]), /outside/);
    await assert.rejects(checkOpenPath(join(f.project, "..", "outside"), [f.project]), /outside/);
    await assert.rejects(checkOpenPath("project/src", [f.project]), /absolute/);
    await assert.rejects(checkOpenPath(join(f.project, "nope"), [f.project]), /does not exist/);
    await assert.rejects(checkOpenPath(42, [f.project]), /invalid/);
    await assert.rejects(checkOpenPath(f.project + "\0", [f.project]), /invalid/);
    // a sibling whose name starts with the root's name is not inside it
    mkdirSync(f.project + "-evil");
    await assert.rejects(checkOpenPath(f.project + "-evil", [f.project]), /outside/);
  } finally {
    f.done();
  }
});

test("refuses a symlink or junction inside a project that escapes it", async () => {
  const f = fixture();
  try {
    const link = join(f.project, "escape");
    // A junction on Windows needs no privilege; a dir symlink elsewhere.
    symlinkSync(f.outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(checkOpenPath(link, [f.project]), /outside/);
    await assert.rejects(checkOpenPath(join(link, "secret.txt"), [f.project]), /outside/);
  } finally {
    f.done();
  }
});

test("a root reached through a link still matches its real path", async () => {
  const f = fixture();
  try {
    const alias = join(f.base, "alias");
    symlinkSync(f.project, alias, process.platform === "win32" ? "junction" : "dir");
    assert.ok(await checkOpenPath(join(f.project, "src"), [alias]));
    assert.ok(await checkOpenPath(join(alias, "src"), [f.project]));
  } finally {
    f.done();
  }
});

test("isInside honours case-insensitivity only when asked", () => {
  // isInside uses the host's path rules, so each platform checks its own path shapes.
  if (process.platform === "win32") {
    assert.equal(isInside("C:\\Work\\Proj\\x", "c:\\work\\proj", true), true);
  } else {
    assert.equal(isInside("/Work/Proj/x", "/work/proj", true), true);
    assert.equal(isInside("/work/Proj/x", "/work/proj", false), false);
  }
});
