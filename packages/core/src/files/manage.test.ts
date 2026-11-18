// Managing project files: rename, move, duplicate and the trash, through the service (confinement and clashes) and routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, stubServices, testDeps } from "../test-helpers.ts";
import { checkName, createFileManager, TRASH_KEEP_MS } from "./manage.ts";

function setup(t: { after(fn: () => void): void }, opts: { busy?: boolean; now?: () => Date } = {}) {
  const deps = testDeps();
  if (opts.now) deps.now = opts.now;
  const root = mkdtempSync(join(tmpdir(), "odin-manage-"));
  t.after(() => { deps.db.close(); rmSync(root, { recursive: true, force: true }); rmSync(join(deps.config.home, ".."), { recursive: true, force: true }); });
  const written: string[][] = [];
  const services = stubServices({});
  services.projects = { get: (n: string) => (n === "p" ? { path: root } : null), noteWritten: (_n: string, paths: string[]) => written.push(paths) } as unknown as typeof services.projects;
  services.notebooks = { usesPath: () => !!opts.busy } as unknown as typeof services.notebooks;
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "a.md"), "A");
  writeFileSync(join(root, "docs", "b.md"), "B");
  return { root, written, m: createFileManager(deps, services), deps };
}

test("rename: same folder only, clashes and bad names refused", (t) => {
  const { root, m, written } = setup(t);
  assert.deepEqual(m.rename("p", "a.md", "c.md"), { path: "c.md" });
  assert.equal(readFileSync(join(root, "c.md"), "utf8"), "A");
  assert.deepEqual(written.at(-1), ["a.md", "c.md"]);
  assert.deepEqual(m.rename("p", "docs/b.md", "x.md"), { path: "docs/x.md" });
  writeFileSync(join(root, "taken.md"), "T");
  assert.throws(() => m.rename("p", "c.md", "taken.md"), { status: 409 });
  for (const bad of ["", "..", "a/b", "a\\b", ".git", "x.", "q?"]) assert.throws(() => m.rename("p", "c.md", bad), { status: 400 }, bad);
  assert.throws(() => m.rename("p", "nope.md", "z.md"), { status: 404 });
  assert.throws(() => m.rename("p", "../outside", "z"), { status: 403 });
  assert.throws(() => m.rename("p", ".git/config", "z"), { status: 403 });
  assert.throws(() => m.rename("nope", "c.md", "z"), { status: 404 });
});

test("move: into a folder or the root; never into itself, over a clash, or through a link", (t) => {
  const { root, m } = setup(t);
  mkdirSync(join(root, "docs", "deep"));
  assert.deepEqual(m.move("p", ["a.md"], "docs"), { moved: [{ from: "a.md", to: "docs/a.md" }] });
  assert.equal(existsSync(join(root, "docs", "a.md")), true);
  assert.deepEqual(m.move("p", ["docs/b.md"], ""), { moved: [{ from: "docs/b.md", to: "b.md" }] });
  assert.throws(() => m.move("p", ["docs"], "docs/deep"), { status: 400 });
  assert.throws(() => m.move("p", ["docs"], "docs"), { status: 400 });
  writeFileSync(join(root, "a.md"), "again");
  assert.throws(() => m.move("p", ["a.md"], "docs"), { status: 409 });
  assert.equal(readFileSync(join(root, "docs", "a.md"), "utf8"), "A", "the existing file is not overwritten");
  assert.throws(() => m.move("p", ["b.md"], "missing"), { status: 404 });
  assert.throws(() => m.move("p", [], "docs"), { status: 400 });
  const outside = mkdtempSync(join(tmpdir(), "odin-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(root, "link"), "dir");
  assert.throws(() => m.move("p", ["b.md"], "link"), { status: 403 });
  assert.throws(() => m.move("p", ["link"], "docs"), { status: 403 });
});

test("duplicate: files only, next to the original, never overwriting", (t) => {
  const { root, m } = setup(t);
  assert.deepEqual(m.duplicate("p", "a.md"), { path: "a copy.md" });
  assert.deepEqual(m.duplicate("p", "a.md"), { path: "a copy 2.md" });
  assert.equal(readFileSync(join(root, "a copy.md"), "utf8"), "A");
  assert.throws(() => m.duplicate("p", "docs"), { status: 400 });
});

test("trash: moves out of the project, lists, restores, purges and expires after 7 days", (t) => {
  let clock = new Date("2026-11-01T00:00:00Z");
  const { root, m } = setup(t, { now: () => clock });
  const [entry] = m.trash("p", ["docs"]);
  assert.equal(entry!.kind, "directory");
  assert.equal(existsSync(join(root, "docs")), false);
  assert.deepEqual(m.listTrash("p").map((e) => e.path), ["docs"]);

  assert.deepEqual(m.restore("p", entry!.id), { path: "docs" });
  assert.equal(readFileSync(join(root, "docs", "b.md"), "utf8"), "B");
  assert.deepEqual(m.listTrash("p"), []);

  const [a] = m.trash("p", ["a.md"]);
  writeFileSync(join(root, "a.md"), "new one");
  assert.throws(() => m.restore("p", a!.id), { status: 409 });
  assert.equal(readFileSync(join(root, "a.md"), "utf8"), "new one");
  assert.throws(() => m.restore("p", "not-an-id"), { status: 400 });

  // The original folder is recreated when it is gone.
  const [b] = m.trash("p", ["docs/b.md"]);
  rmSync(join(root, "docs"), { recursive: true });
  assert.deepEqual(m.restore("p", b!.id), { path: "docs/b.md" });
  assert.equal(readFileSync(join(root, "docs", "b.md"), "utf8"), "B");

  clock = new Date(clock.getTime() + TRASH_KEEP_MS + 1000);
  assert.deepEqual(m.listTrash("p"), [], "expired items are purged");

  const [c] = m.trash("p", ["a.md"]);
  m.purge("p", c!.id);
  assert.deepEqual(m.listTrash("p"), []);
  m.trash("p", ["docs"]);
  m.purge("p");
  assert.deepEqual(m.listTrash("p"), []);
});

test("a running notebook's files can't be renamed, moved or trashed", (t) => {
  const { m } = setup(t, { busy: true });
  assert.throws(() => m.rename("p", "a.md", "z.md"), { status: 409 });
  assert.throws(() => m.move("p", ["a.md"], "docs"), { status: 409 });
  assert.throws(() => m.trash("p", ["a.md"]), { status: 409 });
});

test("checkName accepts ordinary names", () => {
  assert.equal(checkName("  notes v2.md "), "notes v2.md");
  assert.equal(checkName(".env"), ".env");
});

test("file management routes", async () => {
  const t = await startApp();
  try {
    const dir = mkdtempSync(join(tmpdir(), "odin-manage-routes-"));
    writeFileSync(join(dir, "one.txt"), "1");
    const added = await t.api("/api/projects", { method: "POST", body: JSON.stringify({ path: dir, name: "mp" }) });
    assert.ok(added.status < 300);
    const post = (p: string, body: unknown) => t.api(`/api/projects/mp/files/${p}`, { method: "POST", body: JSON.stringify(body) });
    assert.equal((await post("rename", { path: "one.txt", name: "two.txt" })).status, 200);
    assert.equal((await post("duplicate", { path: "two.txt" })).status, 201);
    assert.equal((await post("move", { paths: "two.txt", to: "" })).status, 400);
    const trashed = await post("trash", { paths: ["two.txt"] });
    assert.equal(trashed.status, 200);
    const [entry] = (await trashed.json()) as { id: string }[];
    assert.equal(existsSync(join(dir, "two.txt")), false);
    assert.equal(((await t.json("/api/projects/mp/files/trash")) as unknown[]).length, 1);
    assert.equal((await post(`trash/${entry!.id}/restore`, {})).status, 200);
    assert.equal(existsSync(join(dir, "two.txt")), true);
    assert.equal((await t.api("/api/projects/mp/files/trash", { method: "DELETE" })).status, 204);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    await t.close();
  }
});
