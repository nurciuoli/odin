import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, type TestApp, tempDir } from "../test-helpers.ts";

const root = tempDir("odin-projects-routes-");
let app: TestApp | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

test("a removed project's name can be registered again elsewhere", async () => {
  app = await startApp();
  const first = repo("remove-first", true), second = repo("remove-second", true);
  const { projects } = app.app.services;
  await projects.create({ path: first, name: "reused" });
  projects.remove("reused");
  const next = await projects.create({ path: second, name: "reused" });
  assert.equal(next.path, second);
});

function repo(name: string, plain = false): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  if (!plain) {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "x");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "--quiet", "-m", "init"], { cwd: dir, env });
  }
  return dir;
}

describe("projects routes", () => {
  test("detail carries the session span; archived sessions and the list leave it out", async () => {
    app = await startApp();
    await app.app.services.projects.create({ path: repo("span"), name: "span" });
    const empty = await app.json<any>("/api/projects/span");
    assert.equal(empty.firstSessionAt, null);
    assert.equal(empty.lastSessionAt, null);
    const { sessions } = app.app.services;
    sessions.ensureExternal({ id: "span-1", harness: "claude", project: "span", cwd: "/x", at: "2026-10-02T00:00:00.000Z" });
    sessions.ensureExternal({ id: "span-2", harness: "claude", project: "span", cwd: "/x", at: "2026-10-05T00:00:00.000Z" });
    const old = sessions.ensureExternal({ id: "span-0", harness: "claude", project: "span", cwd: "/x", at: "2026-09-01T00:00:00.000Z" });
    await sessions.update(old.id, { archived: true });
    await sessions.update("span-1", { title: "Renamed much later" });
    const d = await app.json<any>("/api/projects/span");
    assert.equal(d.firstSessionAt, "2026-10-02T00:00:00.000Z");
    assert.equal(d.lastSessionAt, sessions.get("span-2")!.updatedAt);
    const list = await app.json<any[]>("/api/projects");
    assert.equal(list[0].firstSessionAt, undefined);
  });
  test("folder browser lists only visible directories, validates paths and enforces origin", async () => {
    app = await startApp();
    const path = repo("browse", true);
    mkdirSync(join(path, "nested"), { recursive: true });
    mkdirSync(join(path, ".hidden"), { recursive: true });
    writeFileSync(join(path, "file.txt"), "not a folder");
    const browse = (value: string) => app!.api("/api/project-folders", { method: "POST", body: JSON.stringify({ path: value }) });
    const result = await (await browse(path)).json();
    assert.equal(result.path, path);
    assert.equal(result.parent, root);
    assert.deepEqual(result.folders, [{ name: "nested", path: join(path, "nested") }]);
    assert.equal((await browse("relative/folder")).status, 400);
    assert.equal((await browse(join(path, "missing"))).status, 400);
    assert.equal((await browse(join(path, "file.txt"))).status, 400);
    const crossOrigin = await app.api("/api/project-folders", {
      method: "POST", body: JSON.stringify({ path }), headers: { origin: "https://evil.invalid" },
    });
    assert.equal(crossOrigin.status, 403);
  });
  test("register, list, get, patch settings, refresh, delete", async () => {
    app = await startApp();
    const path = repo("alpha");

    const res = await app.api("/api/projects", { method: "POST", body: JSON.stringify({ path }) });
    assert.equal(res.status, 201);
    const created = await res.json();
    assert.equal(created.name, "alpha");
    assert.equal(created.missing, false);
    assert.equal(created.settings.defaultBranch, "main");
    assert.deepEqual(created.agents, []);
    assert.ok(created.sessions && created.sync);
    assert.equal(created.git.branch, "main");

    const list = await app.json<any[]>("/api/projects");
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "alpha");
    assert.equal(list[0].settings, undefined);
    assert.equal(list[0].sessions.total, 0);

    const patched = await app.json("/api/projects/alpha/settings", { method: "PATCH", body: JSON.stringify({ title: "Alpha!", repo: "acme/alpha" }) });
    assert.equal(patched.title, "Alpha!");
    assert.equal(patched.repo, "acme/alpha");
    assert.equal(patched.settings.title, "Alpha!");
    const cleared = await app.json("/api/projects/alpha/settings", { method: "PATCH", body: JSON.stringify({ title: null }) });
    assert.equal(cleared.title, "alpha");

    assert.equal((await app.api("/api/projects/alpha/refresh", { method: "POST" })).status, 204);
    assert.equal((await app.api("/api/projects/nope/refresh", { method: "POST" })).status, 404);
    assert.equal((await app.api("/api/projects/nope")).status, 404);

    assert.equal((await app.api("/api/projects/alpha", { method: "DELETE" })).status, 204);
    assert.deepEqual(await app.json("/api/projects"), []);
    assert.equal((await app.api("/api/projects/alpha", { method: "DELETE" })).status, 404);
  });

  test("plain folders work; duplicate 409, bad name 400, bad settings 400", async () => {
    app = await startApp();
    const plain = repo("plain", true);
    const post = (body: unknown) => app!.api("/api/projects", { method: "POST", body: JSON.stringify(body) });
    assert.equal((await post({ path: plain })).status, 201);
    assert.equal((await post({ path: plain, init: true })).status, 409);
    assert.equal((await post({ path: plain, name: "again" })).status, 409);
    assert.equal((await post({ path: repo("beta"), name: "Bad Name" })).status, 400);
    assert.equal((await post({})).status, 400);
    const bad = await app.api("/api/projects/plain/settings", { method: "PATCH", body: JSON.stringify({ repo: "nope" }) });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /repo/i);
  });

  test("project views: summary activity, branches, worktree removal, artifacts and activity routes", async () => {
    app = await startApp();
    const path = repo("views");
    assert.equal((await app.api("/api/projects", { method: "POST", body: JSON.stringify({ path }) })).status, 201);
    const list = await app.json("/api/projects");
    const summary = list.find((p: { name: string }) => p.name === "views");
    assert.equal(summary.activity.length, 14);
    assert.ok(summary.activity.every((n: number) => n === 0));

    const branches = await app.json("/api/projects/views/branches");
    assert.deepEqual(branches.map((b: { name: string; current: boolean }) => [b.name, b.current]), [["main", true]]);
    assert.equal((await app.api("/api/projects/nope/branches")).status, 404);

    const del = (body: unknown) => app!.api("/api/projects/views/worktrees", { method: "DELETE", body: JSON.stringify(body) });
    assert.equal((await del({ path })).status, 400);
    assert.equal((await del({})).status, 400);
    assert.equal((await del({ path: join(app.config.worktreesDir, "views", "gone") })).status, 204);
    assert.equal((await app.api("/api/projects/nope/worktrees", { method: "DELETE", body: JSON.stringify({ path: "/x" }) })).status, 404);

    assert.deepEqual(await app.json("/api/projects/views/artifacts?limit=4"), []);
    assert.equal((await app.api("/api/projects/views/artifacts?limit=0")).status, 400);
    assert.equal((await app.api("/api/projects/nope/artifacts")).status, 404);
    assert.equal((await app.json("/api/projects/views/activity?days=7")).days.length, 7);
  });
});
