import { after, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDir, tempDir } from "../test-helpers.ts";
import { isDirectory, readRegularFile, readTree, removePath, replaceDirAtomic, resolveInside, writeFileAtomic } from "./files.ts";

const root = tempDir("odin-library-files-");
after(() => removeTempDir(root));
let n = 0;
const fresh = () => {
  const dir = join(root, `case-${n++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test("readTree reads nested files with / keys and skips dotfiles and symlinks", (t) => {
  const dir = fresh();
  mkdirSync(join(dir, "sub", "deep"), { recursive: true });
  writeFileSync(join(dir, "a.md"), "A");
  writeFileSync(join(dir, "sub", "deep", "b.md"), "B");
  writeFileSync(join(dir, ".hidden"), "no");
  try {
    symlinkSync(join(dir, "a.md"), join(dir, "link.md"));
  } catch {
    t.diagnostic("symlinks unavailable here; skipping that part");
  }
  assert.deepEqual(readTree(dir), { files: { "a.md": "A", "sub/deep/b.md": "B" }, error: null });
  assert.deepEqual(readTree(join(dir, "missing")), { files: {}, error: null });
});

test("readRegularFile: text, null when absent or a directory, error when too large", () => {
  const dir = fresh();
  writeFileSync(join(dir, "f.txt"), "hello");
  assert.equal(readRegularFile(join(dir, "f.txt")), "hello");
  assert.equal(readRegularFile(join(dir, "nope")), null);
  assert.equal(readRegularFile(dir), null);
  assert.throws(() => readRegularFile(join(dir, "f.txt"), 2), /larger than/);
  assert.equal(isDirectory(dir), true);
  assert.equal(isDirectory(join(dir, "f.txt")), false);
});

test("resolveInside accepts paths under the root and refuses anything that leaves it", () => {
  const dir = fresh();
  assert.equal(resolveInside(dir, "a/b.md"), join(dir, "a", "b.md"));
  for (const bad of ["../x", "a/../../x", "/etc/passwd", ".."]) assert.throws(() => resolveInside(dir, bad), /escapes its root/, bad);
});

test("resolveInside refuses a symlinked directory that leads out", (t) => {
  const dir = fresh();
  const outside = fresh();
  try {
    symlinkSync(outside, join(dir, "out"), "dir");
  } catch {
    return t.skip("symlinks unavailable here");
  }
  assert.throws(() => resolveInside(dir, "out/file.md"), /escapes its root/);
});

test("writeFileAtomic creates parents, overwrites, and leaves no temp files", () => {
  const dir = fresh();
  const file = join(dir, "x", "y.md");
  writeFileAtomic(file, "one");
  writeFileAtomic(file, "two");
  assert.equal(readFileSync(file, "utf8"), "two");
  assert.deepEqual(readdirSync(join(dir, "x")), ["y.md"]);
});

test("replaceDirAtomic leaves exactly the given files and no temp folders", () => {
  const dir = fresh();
  const target = join(dir, "asset");
  replaceDirAtomic(target, { "a.md": "A", "nested/b.md": "B" });
  replaceDirAtomic(target, { "c.md": "C" });
  assert.deepEqual(readTree(target).files, { "c.md": "C" });
  assert.deepEqual(readdirSync(dir), ["asset"]);
});

test("replaceDirAtomic refuses a bad key and keeps the old directory", () => {
  const dir = fresh();
  const target = join(dir, "asset");
  replaceDirAtomic(target, { "keep.md": "K" });
  assert.throws(() => replaceDirAtomic(target, { "../evil.md": "x" }));
  assert.deepEqual(readTree(target).files, { "keep.md": "K" });
  assert.deepEqual(readdirSync(dir), ["asset"]);
});

test("removePath removes files and folders, and is fine with a missing path", () => {
  const dir = fresh();
  replaceDirAtomic(join(dir, "d"), { "a.md": "A" });
  removePath(join(dir, "d"));
  removePath(join(dir, "d"));
  assert.equal(existsSync(join(dir, "d")), false);
});
