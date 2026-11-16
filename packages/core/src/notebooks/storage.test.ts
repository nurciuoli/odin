import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, linkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNotebookStorage, type IpynbDocument } from "./storage.ts";

const document = (): IpynbDocument => ({ nbformat: 4, nbformat_minor: 5, metadata: { extension: { preserved: true } }, cells: [{ id: "code", cell_type: "code", source: ["x = 1\n", "x"], metadata: { tags: ["analysis"] }, outputs: [], execution_count: null }] });
test("ipynb storage preserves metadata and detects external revisions and unsafe paths", () => {
  const home = mkdtempSync(join(tmpdir(), "odin-notebook-storage-"));
  try {
    const storage = createNotebookStorage(home), first = storage.write("kernel", document(), null);
    assert.deepEqual(storage.read("kernel").document, document());
    const external = JSON.parse(readFileSync(storage.path("kernel"), "utf8")); external.cells[0].source = "external change";
    writeFileSync(storage.path("kernel"), JSON.stringify(external));
    assert.throws(() => storage.write("kernel", document(), first.revision), /changed/);
    assert.equal(storage.read("kernel").document.cells[0].source, "external change");
    assert.throws(() => storage.read("../outside"), /invalid notebook ID/);
    linkSync(storage.path("kernel"), join(home, "linked.ipynb"));
    assert.throws(() => storage.read("kernel"), /regular unlinked file/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("corrupt or unsupported external notebook is refused without overwrite", () => {
  const home = mkdtempSync(join(tmpdir(), "odin-notebook-storage-"));
  try {
    const storage = createNotebookStorage(home); storage.write("kernel", document(), null);
    writeFileSync(storage.path("kernel"), "{bad"); assert.throws(() => storage.read("kernel"), /invalid JSON/);
    writeFileSync(storage.path("kernel"), JSON.stringify({ ...document(), nbformat: 3 })); assert.throws(() => storage.read("kernel"), /unsupported/);
    assert.equal(JSON.parse(readFileSync(storage.path("kernel"), "utf8")).nbformat, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
