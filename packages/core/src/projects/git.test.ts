import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitAll, initRepo, isGitRepo, parseStatusZ, readGitState, repoFromRemoteUrl, statusPaths } from "./git.ts";

test("parseStatusZ reads modified, untracked and renamed entries", () => {
  assert.deepEqual(parseStatusZ(" M a.txt\0?? dir/new file.md\0R  new.txt\0old.txt\0A  b\0"), ["a.txt", "dir/new file.md", "new.txt", "b"]);
  assert.deepEqual(parseStatusZ(""), []);
});

test("repoFromRemoteUrl understands https and ssh remotes", () => {
  assert.equal(repoFromRemoteUrl("https://github.com/acme/demo.git"), "acme/demo");
  assert.equal(repoFromRemoteUrl("git@github.com:acme/demo.git"), "acme/demo");
  assert.equal(repoFromRemoteUrl("https://github.com/acme/demo"), "acme/demo");
  assert.equal(repoFromRemoteUrl("https://example.com/acme/demo.git"), null);
});

test("readGitState on a real repo: branch, head, dirty, and ahead/behind origin", async () => {
  const root = mkdtempSync(join(tmpdir(), "odin-git-"));
  try {
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    mkdirSync(clone);
    execFileSync("git", ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
    await initRepo(clone, "main");
    assert.equal(isGitRepo(clone), true);
    assert.deepEqual((await readGitState(clone, "main")).state, { branch: "main", headSha: null, dirty: false, ahead: 0, behind: 0 });

    writeFileSync(join(clone, "a.txt"), "one");
    await commitAll(clone, "first");
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: clone });
    execFileSync("git", ["push", "--quiet", "-u", "origin", "main"], { cwd: clone, stdio: "pipe" });
    let { state, dirtyPaths } = await readGitState(clone, "main");
    assert.equal(state.branch, "main");
    assert.match(state.headSha!, /^[0-9a-f]{40}$/);
    assert.equal(state.dirty, false);
    assert.deepEqual([state.ahead, state.behind], [0, 0]);

    writeFileSync(join(clone, "b.txt"), "two");
    mkdirSync(join(clone, "sub"));
    writeFileSync(join(clone, "sub", "c.txt"), "three");
    await commitAll(clone, "second");
    writeFileSync(join(clone, "a.txt"), "changed");
    writeFileSync(join(clone, "sub", "d.txt"), "untracked");
    ({ state, dirtyPaths } = await readGitState(clone, "main"));
    assert.equal(state.dirty, true);
    assert.deepEqual([state.ahead, state.behind], [1, 0]);
    assert.deepEqual(dirtyPaths.sort(), ["a.txt", "sub/d.txt"]);
    assert.deepEqual((await statusPaths(clone)).sort(), ["a.txt", "sub/d.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readGitState for a folder that isn't a repo is empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "odin-git-"));
  try {
    assert.deepEqual((await readGitState(root, "main")).state, { branch: null, headSha: null, dirty: false, ahead: 0, behind: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
