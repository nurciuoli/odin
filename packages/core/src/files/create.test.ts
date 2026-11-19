// Creating session files: the service rules (create-only, confinement, limits) and the POST route through the real app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session, SessionTextFile } from "@odin/shared/api";
import { fakeHarness } from "../harness/fake.ts";
import { removeTempDir, startApp, testDeps, stubServices } from "../test-helpers.ts";
import { createFilesService, MAX_FILE_BYTES } from "./service.ts";

function workspace(t: { after(fn: () => void): void }) {
  const deps = testDeps();
  const root = join(deps.config.home, "workspace");
  mkdirSync(root, { recursive: true });
  t.after(() => { deps.db.close(); removeTempDir(join(deps.config.home, "..")); });
  const services = stubServices({});
  services.sessions = { get: (id: string) => (id === "known" ? { cwd: root, project: "test" } : null) } as unknown as typeof services.sessions;
  services.projects = { get: () => null, noteWritten: () => {} } as unknown as typeof services.projects;
  return { root, files: createFilesService(deps, services) };
}

test("create writes a new file, nested folders must exist, and existing paths are never overwritten", (t) => {
  const { root, files } = workspace(t);
  mkdirSync(join(root, "notes"));
  writeFileSync(join(root, "README.md"), "keep me");

  const created = files.create("known", "untitled.md");
  assert.equal(created.path, "untitled.md");
  assert.equal(created.content, "");
  assert.equal(created.size, 0);
  assert.equal(readFileSync(join(root, "untitled.md"), "utf8"), "");

  const json = files.create("known", "notes/data.json", "{}");
  assert.equal(json.path, "notes/data.json");
  assert.equal(json.size, 2);
  assert.equal(readFileSync(join(root, "notes", "data.json"), "utf8"), "{}");
  // The returned version is the one a read or a save sees.
  assert.equal(files.read("known", "notes/data.json").version, json.version);

  assert.throws(() => files.create("known", "README.md", "overwrite"), { status: 409 });
  assert.throws(() => files.create("known", "untitled.md", "again"), { status: 409 });
  assert.equal(readFileSync(join(root, "README.md"), "utf8"), "keep me");
  assert.throws(() => files.create("known", "notes", "a folder"), { status: 409 });

  assert.throws(() => files.create("known", "missing/deeper.md"), { status: 404 });
  assert.equal(existsSync(join(root, "missing")), false);
});

test("create refuses paths that leave the session, git metadata, and oversize or unknown targets", (t) => {
  const { root, files } = workspace(t);
  for (const path of ["../outside.md", "notes/../../outside.md", "/abs.md", "C:/x.md", ".git/config", "name:stream.md", "", "bad."]) {
    assert.throws(() => files.create("known", path), (err: { status?: number }) => err.status === 400 || err.status === 403, path);
  }
  assert.equal(existsSync(join(root, "..", "outside.md")), false);
  assert.throws(() => files.create("known", "big.txt", "x".repeat(MAX_FILE_BYTES + 1)), { status: 413 });
  assert.throws(() => files.create("known", "nul.txt", "a\0b"), { status: 400 });
  assert.throws(() => files.create("missing", "x.md"), { status: 404 });
  assert.equal(existsSync(join(root, "big.txt")), false);
});

test("create never writes through a symbolic link", (t) => {
  const { root, files } = workspace(t);
  const outside = join(root, "..", "outside-target");
  mkdirSync(outside, { recursive: true });
  try { symlinkSync(outside, join(root, "escape"), "junction"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error; return; }
  t.after(() => removeTempDir(outside));
  assert.throws(() => files.create("known", "escape/new.md", "x"), { status: 403 });
  assert.equal(existsSync(join(outside, "new.md")), false);
});

test("POST /api/sessions/:id/files creates files in the session folder over HTTP", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "odin-create-"));
  const repo = join(root, "demo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "README.md"), "# demo\n");
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: repo });
  const app = await startApp({ harnesses: { claude: fakeHarness() } });
  t.after(async () => { await app.close(); removeTempDir(root); });
  const post = (path: string, body: unknown) => app.api(path, { method: "POST", body: JSON.stringify(body) });
  assert.equal((await post("/api/projects", { path: repo })).status, 201);
  const started = await post("/api/sessions", { project: "demo", prompt: { text: "hello" } });
  assert.equal(started.status, 201);
  const session = (await started.json()) as Session;
  const files = `/api/sessions/${session.id}/files`;

  const created = await post(files, { path: "untitled.md" });
  assert.equal(created.status, 201);
  const file = (await created.json()) as SessionTextFile;
  assert.deepEqual({ path: file.path, content: file.content, size: file.size }, { path: "untitled.md", content: "", size: 0 });
  assert.equal(readFileSync(join(repo, "untitled.md"), "utf8"), "");

  const json = await post(files, { path: "config/settings.json", content: "{}" });
  assert.equal(json.status, 404, "the parent folder is not created");
  assert.equal((await post(files, { path: "untitled.md" })).status, 409);
  assert.equal((await post(files, { path: "README.md", content: "x" })).status, 409);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "# demo\n");
  assert.equal((await post(files, { path: "../escape.md" })).status, 403);
  assert.equal((await post(files, { content: "no path" })).status, 400);
  assert.equal((await post(files, { path: "a.txt", content: 3 })).status, 400);
  assert.equal((await post(files, { path: "a.txt", content: "\0" })).status, 400);
  assert.equal((await app.api(files, { method: "POST", body: "{nope" })).status, 400);
  assert.equal((await post("/api/sessions/nope/files", { path: "x.md" })).status, 404);
  assert.equal(existsSync(join(repo, "a.txt")), false);

  const listing = await app.json<{ entries: { name: string }[] }>(`${files}?path=`);
  assert.ok(listing.entries.some(e => e.name === "untitled.md"));
});
