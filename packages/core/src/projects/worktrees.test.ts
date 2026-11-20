// ProjectsService.worktrees / openBranch / existingWorktree and GET /api/projects/:name/worktrees, against temp repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { HttpError } from "../http/util.ts";
import { startApp, stubServices, tempDir, testDeps } from "../test-helpers.ts";
import { createProjectsService } from "./service.ts";

const root = tempDir("odin-worktrees-");
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
const failure = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof HttpError ? e : new HttpError(-1, String(e))));
let counter = 0;

function commit(dir: string, file: string) {
  writeFileSync(join(dir, file), file);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", file);
}

/** A repo on main with a bare origin that also carries `remote-only` (never fetched into a local branch). */
function makeRepo(): string {
  const dir = join(root, `repo${++counter}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, "README.md");
  const origin = join(root, `origin${counter}.git`);
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "--quiet", "-u", "origin", "main");
  git(dir, "checkout", "--quiet", "-b", "remote-only");
  commit(dir, "remote.txt");
  git(dir, "push", "--quiet", "origin", "remote-only");
  git(dir, "checkout", "--quiet", "main");
  git(dir, "branch", "-D", "remote-only");
  git(dir, "fetch", "--quiet", "origin");
  return realpathSync.native(dir);
}

function setup() {
  const deps = testDeps();
  const projects = createProjectsService(deps, stubServices({}));
  const addSession = (id: string, cwd: string, state: string) =>
    deps.db
      .prepare("INSERT INTO sessions (id, harness, project, title, origin, state, cwd, branch, created_at, updated_at, metrics) VALUES (?, 'claude', 'demo', ?, 'odin', ?, ?, NULL, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', '{}')")
      .run(id, `title ${id}`, state, cwd);
  return { deps, projects, addSession };
}

test("openBranch: a remote branch becomes a local tracking branch in a new worktree, then is reused", async () => {
  const { projects } = setup();
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  const wt = await projects.openBranch("demo", "origin/remote-only");
  assert.equal(wt.branch, "remote-only");
  assert.equal(git(wt.path, "symbolic-ref", "--short", "HEAD").trim(), "remote-only");
  assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "remote-only@{upstream}").trim(), "origin/remote-only");
  assert.equal(git(wt.path, "rev-parse", "HEAD").trim(), git(repo, "rev-parse", "origin/remote-only").trim());
  assert.deepEqual(await projects.openBranch("demo", "remote-only"), wt, "the same worktree is reused by local name");
  assert.deepEqual(await projects.openBranch("demo", "origin/remote-only"), wt, "and by remote name");
});

test("openBranch: a bare name that only a remote has, and a local branch", async () => {
  const { projects } = setup();
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  const a = await projects.openBranch("demo", "remote-only");
  assert.equal(a.branch, "remote-only");
  git(repo, "branch", "local-x");
  const b = await projects.openBranch("demo", "local-x");
  assert.equal(git(b.path, "symbolic-ref", "--short", "HEAD").trim(), "local-x");
  assert.ok(existsSync(b.path));
});

test("openBranch: unknown branch is 404, bad name 400, the main checkout's branch 409 checked-out-elsewhere", async () => {
  const { projects } = setup();
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  assert.equal((await failure(projects.openBranch("demo", "nope")))?.status, 404);
  assert.equal((await failure(projects.openBranch("demo", "--force")))?.status, 400);
  const err = await failure(projects.openBranch("demo", "main"));
  assert.equal(err?.status, 409);
  assert.equal(err?.code, "checked-out-elsewhere");
  assert.equal((await failure(projects.openBranch("nope", "main")))?.status, 404);
});

test("openBranch reuses a worktree the user made outside Odin's folder", async () => {
  const { projects } = setup();
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  git(repo, "branch", "mine");
  const own = join(root, `own${counter}`);
  git(repo, "worktree", "add", "--quiet", own, "mine");
  const wt = await projects.openBranch("demo", "mine");
  assert.equal(normalize(wt.path), normalize(realpathSync.native(own)));
});

test("existingWorktree accepts the main checkout and linked worktrees, refuses other paths", async () => {
  const { projects } = setup();
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  const wt = await projects.createWorktree("demo", "feature/a");
  const main = await projects.existingWorktree("demo", repo);
  assert.deepEqual([main.main, main.branch], [true, "main"]);
  const linked = await projects.existingWorktree("demo", wt.path);
  assert.deepEqual([linked.main, linked.branch, normalize(linked.path)], [false, "feature/a", normalize(wt.path)]);
  assert.equal((await failure(projects.existingWorktree("demo", root)))?.status, 400);
  assert.equal((await failure(projects.existingWorktree("demo", "relative/dir")))?.status, 400);
  assert.equal((await failure(projects.existingWorktree("demo", join(repo, "..", "elsewhere"))))?.status, 400);
});

test("worktrees lists main + linked with status, merge state and sessions", async () => {
  const { projects, addSession } = setup();
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  const merged = await projects.createWorktree("demo", "done"); // at main: fully merged, 0/0
  const busy = await projects.createWorktree("demo", "busy");
  commit(busy.path, "b1");
  commit(busy.path, "b2");
  commit(repo, "m1");
  writeFileSync(join(busy.path, "dirty.txt"), "x");
  addSession("run", busy.path, "running");
  addSession("old", busy.path, "ended");
  addSession("main-s", repo, "idle");

  const out = await projects.worktrees("demo");
  assert.equal(out.mainBranch, "main");
  assert.equal(out.baseBranch, "main");
  assert.equal(out.worktrees.length, 3);
  const [m, ...rest] = out.worktrees;
  assert.deepEqual([normalize(m!.path), m!.main, m!.branch, m!.merged, m!.dirty], [normalize(repo), true, "main", false, false]);
  assert.deepEqual(m!.sessions, [{ id: "main-s", title: "title main-s", state: "idle", running: false }]);
  const byBranch = Object.fromEntries(rest.map((w) => [w.branch ?? "", w] as const));
  const b = byBranch.busy!;
  // The base is origin/main (not moved by the local commit m1): busy is 2 ahead, 0 behind.
  assert.deepEqual([b.main, b.ahead, b.behind, b.merged, b.dirty], [false, 2, 0, false, true]);
  assert.deepEqual(b.sessions.map((s) => [s.id, s.running]).sort(), [["old", false], ["run", true]]);
  assert.match(b.headSha ?? "", /^[0-9a-f]{40}$/);
  const d = byBranch.done!;
  assert.deepEqual([normalize(d.path), d.merged, d.ahead, d.dirty, d.sessions], [normalize(merged.path), true, 0, false, []]);
});

test("GET /api/projects/:name/worktrees serves the list; unknown project is 404", async () => {
  const app = await startApp();
  try {
    const repo = makeRepo();
    await app.app.services.projects.create({ path: repo, name: "demo" });
    const body = await app.json<{ mainBranch: string; baseBranch: string; worktrees: { main: boolean }[] }>("/api/projects/demo/worktrees");
    assert.equal(body.mainBranch, "main");
    assert.equal(body.baseBranch, "main");
    assert.deepEqual(body.worktrees.map((w) => w.main), [true]);
    assert.equal((await app.api("/api/projects/nope/worktrees")).status, 404);
  } finally {
    await app.close();
  }
});

test("openBranch and localBranchName resolve against any remote, not only origin", async () => {
  const { projects } = setup();
  const repo = makeRepo();
  git(repo, "remote", "rename", "origin", "upstream");
  await projects.create({ path: repo, name: "demo" });
  assert.equal(await projects.localBranchName("demo", "upstream/remote-only"), "remote-only");
  assert.equal(await projects.localBranchName("demo", "remote-only"), "remote-only");
  assert.equal(await projects.localBranchName("demo", "main"), "main");
  const wt = await projects.openBranch("demo", "upstream/remote-only");
  assert.equal(git(wt.path, "rev-parse", "--abbrev-ref", "remote-only@{upstream}").trim(), "upstream/remote-only");
  assert.equal((await failure(projects.localBranchName("demo", "other/nope")))?.status, 404);
});

test("createWorktree fromCwd starts at that folder's HEAD, and resolveCwd maps the user's own worktrees", async () => {
  const { projects } = setup();
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  const own = join(root, `mine${counter}`);
  git(repo, "worktree", "add", "--quiet", "-b", "mine", own);
  commit(own, "own.txt");
  const head = git(own, "rev-parse", "HEAD").trim();
  const wt = await projects.createWorktree("demo", "feature/fork", { fromCwd: own });
  assert.equal(git(wt.path, "rev-parse", "HEAD").trim(), head);
  assert.equal(projects.resolveCwd(join(own, "sub")), "demo");
  assert.equal(projects.resolveCwd(join(root, "unrelated")), null);
});
