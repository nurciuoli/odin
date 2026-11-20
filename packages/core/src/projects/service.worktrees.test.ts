import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, makeRepo, root, setup, status } from "./test-repo.ts";

describe("worktrees", () => {
  test("create from origin/<default>, reuse, remove", async () => {
    const { deps, projects } = setup();
    const a = makeRepo({ origin: true });
    await projects.create({ path: a.path, name: "wt" });
    // Local main moves ahead of origin/main: the worktree must start from origin/main.
    const originSha = git(a.path, "rev-parse", "origin/main").trim();
    writeFileSync(join(a.path, "local.txt"), "x");
    git(a.path, "add", "-A");
    git(a.path, "commit", "--quiet", "-m", "local only");

    const wt = await projects.createWorktree("wt", "item/12-fix-login");
    assert.equal(wt.branch, "item/12-fix-login");
    assert.equal(wt.path, join(realpathSync.native(deps.config.worktreesDir), "wt", "item-12-fix-login"));
    assert.equal(git(wt.path, "rev-parse", "HEAD").trim(), originSha);
    assert.equal(git(wt.path, "symbolic-ref", "--short", "HEAD").trim(), "item/12-fix-login");
    assert.throws(() => git(wt.path, "rev-parse", "--abbrev-ref", "@{upstream}"));

    const again = await projects.createWorktree("wt", "item/12-fix-login");
    assert.deepEqual(again, wt);

    assert.equal(projects.resolveCwd(wt.path), "wt");
    assert.equal(projects.resolveCwd(join(wt.path, "sub", "dir")), "wt");

    await projects.removeWorktree("wt", wt.path);
    assert.equal(existsSync(wt.path), false);
    assert.equal(git(a.path, "rev-parse", "--verify", "item/12-fix-login").trim().length, 40, "branch is kept");

    // An existing branch is checked out instead of created.
    const reused = await projects.createWorktree("wt", "item/12-fix-login");
    assert.equal(git(reused.path, "symbolic-ref", "--short", "HEAD").trim(), "item/12-fix-login");
  });

  test("without origin the local default branch is the base", async () => {
    const { projects } = setup();
    const a = makeRepo();
    await projects.create({ path: a.path, name: "wl" });
    const sha = git(a.path, "rev-parse", "main").trim();
    const wt = await projects.createWorktree("wl", "feature/x");
    assert.equal(git(wt.path, "rev-parse", "HEAD").trim(), sha);
  });

  test("branches whose slugs collide get distinct directories", async () => {
    const { projects } = setup();
    const a = makeRepo();
    await projects.create({ path: a.path, name: "wc" });
    const one = await projects.createWorktree("wc", "a/b");
    const two = await projects.createWorktree("wc", "a-b");
    assert.notEqual(one.path, two.path);
  });

  test("bad branch names and the main clone's branch are refused", async () => {
    const { projects } = setup();
    const a = makeRepo();
    await projects.create({ path: a.path, name: "wb" });
    assert.equal(await status(projects.createWorktree("wb", "--force")), 400);
    assert.equal(await status(projects.createWorktree("wb", "a..b")), 400);
    assert.equal(await status(projects.createWorktree("wb", "x y")), 400);
    assert.equal(await status(projects.createWorktree("wb", "main")), 409);
    assert.equal(await status(projects.createWorktree("nope", "x")), 404);
  });

  test("removeWorktree refuses paths outside the project's worktree dir", async () => {
    const { deps, projects } = setup();
    const a = makeRepo();
    const b = makeRepo();
    await projects.create({ path: a.path, name: "wa" });
    await projects.create({ path: b.path, name: "wb2" });
    const other = await projects.createWorktree("wb2", "feat");
    assert.equal(await status(projects.removeWorktree("wa", a.path)), 400);
    assert.equal(await status(projects.removeWorktree("wa", deps.config.worktreesDir)), 400);
    assert.equal(await status(projects.removeWorktree("wa", join(deps.config.worktreesDir, "wa"))), 400);
    assert.equal(await status(projects.removeWorktree("wa", other.path)), 400);
    assert.equal(await status(projects.removeWorktree("wa", join(deps.config.worktreesDir, "wa", "..", "wb2", "feat"))), 400);
    assert.equal(await status(projects.removeWorktree("wa", "relative")), 400);
    assert.ok(existsSync(other.path));
  });
});


describe("base remote", () => {
  test("a repo whose only remote is not called origin bases worktrees on it", async () => {
    const { projects } = setup();
    const a = makeRepo({ origin: true });
    git(a.path, "remote", "rename", "origin", "upstream");
    await projects.create({ path: a.path, name: "wu" });
    const remoteSha = git(a.path, "rev-parse", "upstream/main").trim();
    writeFileSync(join(a.path, "local.txt"), "x");
    git(a.path, "add", "-A");
    git(a.path, "commit", "--quiet", "-m", "local only");
    const wt = await projects.createWorktree("wu", "feature/y");
    assert.equal(git(wt.path, "rev-parse", "HEAD").trim(), remoteSha);
  });

  test("the default branch's configured remote wins over origin", async () => {
    const { projects } = setup();
    const a = makeRepo({ origin: true });
    const fork = join(root, "fork-bare.git");
    git(root, "clone", "--quiet", "--bare", a.path, fork);
    git(a.path, "remote", "add", "work", fork);
    git(a.path, "fetch", "--quiet", "work");
    writeFileSync(join(a.path, "w.txt"), "x");
    git(a.path, "add", "-A");
    git(a.path, "commit", "--quiet", "-m", "on work");
    git(a.path, "push", "--quiet", "work", "main");
    git(a.path, "config", "branch.main.remote", "work");
    await projects.create({ path: a.path, name: "ww" });
    const workSha = git(a.path, "rev-parse", "work/main").trim();
    const wt = await projects.createWorktree("ww", "feature/z");
    assert.equal(git(wt.path, "rev-parse", "HEAD").trim(), workSha);
  });
});
