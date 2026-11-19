import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointStore, MAX_FILE_BYTES } from "./store.ts";
import { tempDir, removeTempDir } from "../test-helpers.ts";

function fixture() {
  const base = tempDir("odin-ckpt-");
  const cwd = join(base, "work");
  mkdirSync(cwd, { recursive: true });
  const store = new CheckpointStore(join(base, "store"), "demo");
  return { base, cwd, store, done: () => removeTempDir(base) };
}
const put = (cwd: string, path: string, text: string) => {
  const full = join(cwd, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
};
const snap = async (store: CheckpointStore, cwd: string) => {
  const s = await store.snapshot(cwd);
  assert.ok(s.ok, s.ok ? "" : s.reason);
  return s.tree;
};

test("snapshot honours .gitignore, and diff names added, modified and removed files", async () => {
  const f = fixture();
  try {
    put(f.cwd, ".gitignore", "build/\n");
    put(f.cwd, "a.txt", "one");
    put(f.cwd, "src/b.txt", "two");
    put(f.cwd, "build/out.js", "ignored");
    const t1 = await snap(f.store, f.cwd);
    assert.equal(await snap(f.store, f.cwd), t1, "same state, same tree");
    put(f.cwd, "a.txt", "changed");
    rmSync(join(f.cwd, "src/b.txt"));
    put(f.cwd, "c.txt", "new");
    const t2 = await snap(f.store, f.cwd);
    const d = await f.store.diff(t1, t2);
    assert.deepEqual(d.files, [{ path: "a.txt", status: "modified" }, { path: "c.txt", status: "added" }, { path: "src/b.txt", status: "removed" }]);
    assert.equal(d.truncated, false);
    assert.equal((await f.store.diff(null, t1)).all.some((c) => c.path.startsWith("build/")), false, "ignored files are not captured");
  } finally { f.done(); }
});

test("restore writes changed files back, deletes only what the target lacks, and leaves ignored files alone", async () => {
  const f = fixture();
  try {
    put(f.cwd, ".gitignore", "build/\n");
    put(f.cwd, "a.txt", "one");
    put(f.cwd, "src/b.txt", "two");
    const before = await snap(f.store, f.cwd);
    put(f.cwd, "a.txt", "changed");
    rmSync(join(f.cwd, "src/b.txt"));
    put(f.cwd, "src/deep/new.txt", "new");
    put(f.cwd, "build/out.js", "ignored");
    const current = await snap(f.store, f.cwd);
    await f.store.restore(f.cwd, current, before);
    assert.equal(readFileSync(join(f.cwd, "a.txt"), "utf8"), "one");
    assert.equal(readFileSync(join(f.cwd, "src/b.txt"), "utf8"), "two");
    assert.equal(existsSync(join(f.cwd, "src/deep/new.txt")), false);
    assert.equal(existsSync(join(f.cwd, "src/deep")), false, "emptied directories go too");
    assert.equal(readFileSync(join(f.cwd, "build/out.js"), "utf8"), "ignored");
    assert.equal(await snap(f.store, f.cwd), before);
    await f.store.restore(f.cwd, before, current);
    assert.equal(readFileSync(join(f.cwd, "a.txt"), "utf8"), "changed", "a restore can be undone");
  } finally { f.done(); }
});

test("files over the size cap are left out of snapshots and never deleted by a restore", async () => {
  const f = fixture();
  try {
    put(f.cwd, "a.txt", "one");
    put(f.cwd, "big.bin", "x".repeat(MAX_FILE_BYTES + 1));
    const t1 = await snap(f.store, f.cwd);
    assert.deepEqual((await f.store.diff(null, t1)).files.map((c) => c.path), ["a.txt"]);
    put(f.cwd, "a.txt", "two");
    const t2 = await snap(f.store, f.cwd);
    await f.store.restore(f.cwd, t2, t1);
    assert.equal(readFileSync(join(f.cwd, "a.txt"), "utf8"), "one");
    assert.equal(existsSync(join(f.cwd, "big.bin")), true);
  } finally { f.done(); }
});

test("materialize fills another directory from a tree and drops its tracked files the tree lacks", async () => {
  const f = fixture();
  try {
    put(f.cwd, "a.txt", "one");
    put(f.cwd, "src/b.txt", "two");
    const tree = await snap(f.store, f.cwd);
    const other = join(f.base, "other");
    mkdirSync(other);
    put(other, "stale.txt", "untracked, stays (not a git checkout)");
    await f.store.materialize(other, tree);
    assert.equal(readFileSync(join(other, "src/b.txt"), "utf8"), "two");
    assert.equal(readFileSync(join(other, "a.txt"), "utf8"), "one");
  } finally { f.done(); }
});

test("a missing working directory is a skipped snapshot, not a crash", async () => {
  const f = fixture();
  try {
    const s = await f.store.snapshot(join(f.base, "nope"));
    assert.equal(s.ok, false);
    assert.equal(!s.ok && s.skipped, true);
  } finally { f.done(); }
});

test("release drops the refs of unreferenced trees", async () => {
  const f = fixture();
  try {
    put(f.cwd, "a.txt", "one");
    const tree = await snap(f.store, f.cwd);
    await f.store.release([tree], true);
    put(f.cwd, "a.txt", "two");
    assert.notEqual(await snap(f.store, f.cwd), tree);
  } finally { f.done(); }
});
