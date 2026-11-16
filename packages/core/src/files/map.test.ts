import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildMap, parseNumstat } from "./map.ts";
import { git, makeRepo } from "../projects/test-repo.ts";
import { startApp } from "../test-helpers.ts";

test("parseNumstat reads counts and skips binary files", () => {
  const out = ["3\t1\ta.ts", "-\t-\timg.png", "0\t5\tdir/b.ts", ""].join("\0");
  assert.deepEqual([...parseNumstat(out)], [["a.ts", [3, 1]], ["dir/b.ts", [0, 5]]]);
});

test("the map carries sizes, lines and the working-tree diff against HEAD", () => {
  const repo = makeRepo({ files: { "src/a.ts": "one\ntwo\nthree\nfour\n", "src/gone.ts": "x\n", "bin.dat": "x" } });
  git(repo.path, "commit", "--quiet", "--allow-empty", "-m", "noop");
  writeFileSync(join(repo.path, "src/a.ts"), "one\nTWO\nthree\nfour\nfive\n");
  rmSync(join(repo.path, "src/gone.ts"));
  writeFileSync(join(repo.path, "new.ts"), "a\nb\n");
  writeFileSync(join(repo.path, "bin.dat"), Buffer.from([0, 1, 2]));
  writeFileSync(join(repo.path, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(repo.path, "ignored.txt"), "nope\n");
  const map = buildMap(repo.path);
  const by = Object.fromEntries(map.files.map(f => [f.path, f]));
  assert.equal(by["src/a.ts"]!.lines, 5);
  assert.deepEqual([by["src/a.ts"]!.added, by["src/a.ts"]!.removed], [2, 1]);
  assert.deepEqual([by["new.ts"]!.added, by["new.ts"]!.removed], [2, 0]);
  assert.equal(by["bin.dat"]!.lines, undefined);
  assert.equal(by["bin.dat"]!.added, undefined);
  assert.equal(by["README.md"]!.added, undefined);
  assert.equal(by["src/gone.ts"], undefined, "deleted files are left out");
  assert.equal(by["ignored.txt"], undefined, ".gitignore applies");
  assert.equal(map.truncated, false);
});

test("GET /api/projects/:name/files/map serves the map, and 404s an unknown project", async () => {
  const app = await startApp();
  try {
    const repo = makeRepo({ files: { "a/b.ts": "x\ny\n" } });
    await app.app.services.projects.create({ path: repo.path, name: "mapped" });
    writeFileSync(join(repo.path, "a/b.ts"), "x\nz\nw\n");
    const map = await app.json<{ files: { path: string; added?: number; removed?: number }[] }>("/api/projects/mapped/files/map");
    const file = map.files.find(f => f.path === "a/b.ts")!;
    assert.deepEqual([file.added, file.removed], [2, 1]);
    assert.equal((await app.api("/api/projects/nope/files/map")).status, 404);
  } finally {
    await app.close();
  }
});

test("GET /api/projects/:name/file reads a project file and keeps to the folder", async () => {
  const app = await startApp();
  try {
    const repo = makeRepo({ files: { "a/b.ts": "hello\n" } });
    await app.app.services.projects.create({ path: repo.path, name: "readable" });
    const file = await app.json<{ path: string; content: string }>("/api/projects/readable/file?path=a/b.ts");
    assert.deepEqual([file.path, file.content], ["a/b.ts", "hello\n"]);
    const q = (p: string) => app.api(`/api/projects/readable/file?path=${encodeURIComponent(p)}`);
    assert.equal((await q("../outside")).status, 403);
    assert.equal((await q(".git/config")).status, 403);
    assert.equal((await q("missing.ts")).status, 404);
    assert.equal((await app.api("/api/projects/nope/file?path=a")).status, 404);
  } finally {
    await app.close();
  }
});
