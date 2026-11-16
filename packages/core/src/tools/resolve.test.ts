import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../db/db.ts";
import { gitBinary, readToolPaths, resolveTool, setToolPathSource, toolOverride } from "./resolve.ts";

test("resolveTool: bare name without override, override wins, read lazily", () => {
  let paths: Record<string, string> = {};
  setToolPathSource(() => paths);
  try {
    assert.equal(resolveTool("gh"), "gh");
    assert.equal(gitBinary(), "git");
    paths = { git: "/opt/git/bin/git" };
    assert.equal(gitBinary(), "/opt/git/bin/git");
    assert.equal(toolOverride("gh"), null);
    setToolPathSource(() => {
      throw new Error("db closed");
    });
    assert.equal(resolveTool("git"), "git");
  } finally {
    setToolPathSource(null);
  }
  assert.equal(resolveTool("claude"), "claude");
});

test("readToolPaths: reads the app_settings row, ignores junk", () => {
  const db = openDb(":memory:");
  try {
    assert.deepEqual(readToolPaths(db), {});
    const abs = process.platform === "win32" ? "C:\\tools\\gh.exe" : "/usr/local/bin/gh";
    db.prepare("INSERT INTO app_settings (key, value) VALUES ('toolPaths', ?)").run(JSON.stringify({ gh: abs, node: abs, git: "rel/git" }));
    assert.deepEqual(readToolPaths(db), { gh: abs });
    db.prepare("UPDATE app_settings SET value = 'not json' WHERE key = 'toolPaths'").run();
    assert.deepEqual(readToolPaths(db), {});
  } finally {
    db.close();
  }
});
