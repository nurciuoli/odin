// ProjectsService.branches and the worktree removal rules, against temp repos (docs/contracts.md#projects).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { HttpError } from "../http/util.ts";
import type { PullInfo, SyncService } from "../services.ts";
import { stubServices, testDeps } from "../test-helpers.ts";
import { parseWorktreeList } from "./git.ts";
import { createProjectsService } from "./service.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "odin-branches-")));
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
const status = async (p: Promise<unknown>) => p.then(() => 0, (e) => (e instanceof HttpError ? e.status : -1));
let counter = 0;

function commit(dir: string, file: string) {
  writeFileSync(join(dir, file), file);
  git(dir, "add", "-A");
  git(dir, "commit", "--quiet", "-m", file);
}

function makeRepo(): string {
  const dir = join(root, `repo${++counter}`);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--quiet", "--initial-branch=main");
  commit(dir, "README.md");
  return dir;
}

function setup(pulls: Record<string, PullInfo> = {}) {
  const deps = testDeps();
  const sync = { pullForBranch: (_p: string, b: string) => pulls[b] ?? null } as unknown as SyncService;
  const projects = createProjectsService(deps, stubServices({ sync }));
  const addSession = (id: string, o: { branch?: string | null; cwd?: string; state?: string; createdAt?: string; pull?: object } = {}) =>
    deps.db
      .prepare("INSERT INTO sessions (id, harness, project, title, origin, state, cwd, branch, pull, created_at, updated_at, metrics) VALUES (?, 'claude', 'demo', 't', 'odin', ?, ?, ?, ?, ?, ?, '{}')")
      .run(id, o.state ?? "ended", o.cwd ?? "/x", o.branch ?? null, o.pull ? JSON.stringify(o.pull) : null, o.createdAt ?? "2026-10-01T00:00:00Z", o.createdAt ?? "2026-10-01T00:00:00Z");
  return { deps, projects, addSession };
}

test("parseWorktreeList reads paths and branches; detached heads have none", () => {
  const out = "worktree /a\nHEAD 1\nbranch refs/heads/main\n\nworktree /b\nHEAD 2\ndetached\n\nworktree /c\nHEAD 3\nbranch refs/heads/x/y\nprunable gitdir file points to non-existent location\n";
  assert.deepEqual(parseWorktreeList(out), [{ path: "/a", branch: "main" }, { path: "/b", branch: null }, { path: "/c", branch: "x/y" }]);
});

test("branches: ahead/behind/merged against the default, worktrees, current, sessions and pulls", async () => {
  const pull: PullInfo = { number: 4, url: "https://x/pull/4", headBranch: "feature", state: "open", merged: false, reviewRounds: 0, files: [], closes: [] };
  const { projects, addSession } = setup({ feature: pull });
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  git(repo, "branch", "done");
  git(repo, "checkout", "--quiet", "-b", "feature");
  commit(repo, "f1");
  commit(repo, "f2");
  git(repo, "checkout", "--quiet", "main");
  commit(repo, "m1");
  const wt = await projects.createWorktree("demo", "stale");
  addSession("old", { branch: "feature", createdAt: "2026-10-01T00:00:00Z" });
  addSession("new", { branch: "feature", createdAt: "2026-10-02T00:00:00Z" });
  addSession("s-pr", { branch: "done", pull: { number: 9, url: "https://x/pull/9", state: "closed", merged: true } });

  const list = await projects.branches("demo");
  const by = Object.fromEntries(list.map((b) => [b.name, b]));
  assert.deepEqual(Object.keys(by).sort(), ["done", "feature", "main", "stale"]);
  assert.deepEqual([by.feature!.ahead, by.feature!.behind, by.feature!.merged], [2, 1, false]);
  assert.deepEqual([by.done!.ahead, by.done!.behind, by.done!.merged], [0, 1, true]);
  assert.deepEqual([by.main!.current, normalize(by.main!.worktreePath!), by.feature!.current], [true, repo, false]);
  assert.equal(normalize(by.stale!.worktreePath!), normalize(wt.path));
  assert.equal(by.feature!.worktreePath, null);
  assert.deepEqual(by.feature!.sessionIds, ["new", "old"]);
  assert.deepEqual(by.feature!.pull, { number: 4, url: pull.url, state: "open", merged: false });
  assert.deepEqual(by.done!.pull, { number: 9, url: "https://x/pull/9", state: "closed", merged: true });
  assert.match(by.main!.headSha, /^[0-9a-f]{40}$/);
  assert.ok(!Number.isNaN(Date.parse(by.main!.lastCommitAt)));

  // origin/main wins over main once it exists.
  git(repo, "update-ref", "refs/remotes/origin/main", "main~1");
  const again = Object.fromEntries((await projects.branches("demo")).map((b) => [b.name, b]));
  assert.deepEqual([again.feature!.ahead, again.feature!.behind], [2, 0]);
  assert.equal(again.main!.ahead, 1);

  assert.equal(await status(projects.branches("nope")), 404);
  await projects.close();
});

test("removeWorktree: 409 with a live session inside or a dirty tree, 400 for the checkout, prunes a missing path", async () => {
  const { projects, addSession, deps } = setup();
  const repo = makeRepo();
  await projects.create({ path: repo, name: "demo" });
  const wt = await projects.createWorktree("demo", "busy");
  assert.equal(await status(projects.removeWorktree("demo", repo)), 400);

  addSession("live", { cwd: join(wt.path, "sub"), state: "idle" });
  assert.equal(await status(projects.removeWorktree("demo", wt.path)), 409);
  deps.db.prepare("UPDATE sessions SET state = 'ended' WHERE id = 'live'").run();

  writeFileSync(join(wt.path, "dirty.txt"), "x");
  assert.equal(await status(projects.removeWorktree("demo", wt.path)), 409);
  assert.ok(existsSync(wt.path));
  unlinkSync(join(wt.path, "dirty.txt"));

  await projects.removeWorktree("demo", wt.path);
  assert.equal(existsSync(wt.path), false);
  assert.ok((await projects.branches("demo")).some((b) => b.name === "busy" && b.worktreePath === null), "branch kept");
  // Already gone: pruned, no error.
  await projects.removeWorktree("demo", wt.path);
  await projects.close();
});
