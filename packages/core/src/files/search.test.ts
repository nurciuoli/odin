import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndex, createFileSearch, fuzzyScore, rank } from "./search.ts";
import { tempDir, removeTempDir } from "../test-helpers.ts";

function tree(root: string, files: string[]) {
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "x");
  }
}

test("fuzzy ranking prefers basename and contiguous matches", () => {
  assert.equal(fuzzyScore("src/app.ts", "xyz"), null);
  const index = { files: ["src/components/Composer.vue", "docs/compose-notes.md", "src/composer/index.ts", "packages/core/src/main.ts"], dirs: ["src", "src/components", "src/composer", "docs", "packages", "packages/core", "packages/core/src"], truncated: false };
  const matches = rank(index, "composer");
  assert.equal(matches[0]!.path, "src/composer");
  assert.deepEqual(matches.slice(1, 3).map((m) => m.path).sort(), ["src/components/Composer.vue", "src/composer/index.ts"]);
  assert.ok(!matches.some((m) => m.path === "docs/compose-notes.md"));
  assert.deepEqual(rank(index, "").map((m) => [m.path, m.kind]), [["docs", "directory"], ["packages", "directory"], ["src", "directory"]]);
});

test("the git index honours .gitignore; the fallback walk skips dot folders and node_modules; results are cached", () => {
  const root = tempDir("odin-search-");
  try {
    const plain = join(root, "plain");
    tree(plain, ["a/one.ts", ".hidden/secret.ts", "node_modules/dep/index.js", "top.md"]);
    const walked = buildIndex(plain);
    assert.deepEqual(walked.files.sort(), ["a/one.ts", "top.md"]);
    assert.deepEqual(walked.dirs, ["a"]);

    const repo = join(root, "repo");
    tree(repo, ["src/keep.ts", "build/out.js", ".gitignore"]);
    writeFileSync(join(repo, ".gitignore"), "build/\n");
    let hasGit = true;
    try { execFileSync("git", ["init", "-q", repo], { stdio: "ignore" }); } catch { hasGit = false; }
    if (hasGit) assert.deepEqual(buildIndex(repo).files.sort(), [".gitignore", "src/keep.ts"]);

    let clock = 0;
    const search = createFileSearch(() => clock);
    assert.deepEqual(search(plain, "one").matches, [{ path: "a/one.ts", kind: "file" }]);
    writeFileSync(join(plain, "a", "onemore.ts"), "x");
    assert.equal(search(plain, "one").matches.length, 1);
    clock = 20_000;
    assert.equal(search(plain, "one").matches.length, 2);
    assert.equal(search(plain, 42).query, "");
  } finally {
    removeTempDir(root);
  }
});
