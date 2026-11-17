import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNotebookStorage, normalizeNotebookPath, type IpynbDocument } from "./storage.ts";

const document = (): IpynbDocument => ({ nbformat: 4, nbformat_minor: 5, metadata: { extension: { preserved: true } }, cells: [{ id: "code", cell_type: "code", source: ["x = 1\n", "x"], metadata: { tags: ["analysis"] }, outputs: [], execution_count: null }] });
const temp = () => mkdtempSync(join(tmpdir(), "odin-notebook-storage-"));

test("ipynb storage preserves metadata and detects external revisions", () => {
  const root = temp();
  try {
    const storage = createNotebookStorage(), first = storage.write(root, "a/nb.ipynb", document(), null);
    assert.deepEqual(storage.read(root, "a/nb.ipynb").document, document());
    assert.throws(() => storage.write(root, "a/nb.ipynb", document(), null), /already exists/);
    const file = join(root, "a", "nb.ipynb"), external = JSON.parse(readFileSync(file, "utf8")); external.cells[0].source = "external change";
    writeFileSync(file, JSON.stringify(external));
    assert.throws(() => storage.write(root, "a/nb.ipynb", document(), first.revision), /changed/);
    assert.equal(storage.read(root, "a/nb.ipynb").document.cells[0].source, "external change");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create writes an empty nbformat 4.5 notebook with parent folders", () => {
  const root = temp();
  try {
    const storage = createNotebookStorage(); storage.create(root, "deep/er/new.ipynb");
    const doc = JSON.parse(readFileSync(join(root, "deep", "er", "new.ipynb"), "utf8"));
    assert.deepEqual(doc, { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } }, cells: [] });
    assert.equal(storage.exists(root, "deep/er/new.ipynb"), true); assert.equal(storage.exists(root, "nope/x.ipynb"), false);
    assert.equal(storage.read(root, "deep/er/new.ipynb").document.cells.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("paths are validated and cannot escape the project root", () => {
  const root = temp(), outside = temp();
  try {
    const storage = createNotebookStorage();
    for (const bad of ["../x.ipynb", "/x.ipynb", "C:/x.ipynb", "x.json", "a//b.ipynb", "a/./b.ipynb", ".git/x.ipynb"]) assert.throws(() => normalizeNotebookPath(bad), /notebook path|\.ipynb/, bad);
    assert.equal(normalizeNotebookPath("a\\b.ipynb"), "a/b.ipynb");
    let linked = false;
    try { symlinkSync(outside, join(root, "link"), "junction"); linked = true; } catch { /* symlinks may be unavailable */ }
    if (linked) assert.throws(() => storage.write(root, "link/x.ipynb", document(), null), /regular project directory/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test("corrupt or unsupported external notebook is refused without overwrite", () => {
  const root = temp();
  try {
    const storage = createNotebookStorage(), file = join(root, "nb.ipynb"); storage.write(root, "nb.ipynb", document(), null);
    writeFileSync(file, "{bad"); assert.throws(() => storage.read(root, "nb.ipynb"), /invalid JSON/);
    writeFileSync(file, JSON.stringify({ ...document(), nbformat: 3 })); assert.throws(() => storage.read(root, "nb.ipynb"), /unsupported/);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).nbformat, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
