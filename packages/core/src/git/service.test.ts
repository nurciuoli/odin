import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@odin/shared/api";
import type { GitTarget } from "@odin/shared/git";
import { HttpError } from "../http/util.ts";
import type { ProjectRef } from "../services.ts";
import { stubServices, testDeps, tempDir, removeTempDir } from "../test-helpers.ts";
import { cleanRelPath, createGitService } from "./service.ts";

const root = tempDir("odin-git-");
after(() => removeTempDir(root));

// Commits need an identity; the test process never reads the user's global git config.
const ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: join(root, "no-gitconfig"), GIT_CONFIG_NOSYSTEM: "1" };
before(() => Object.assign(process.env, ENV));
const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: { ...process.env, ...ENV }, encoding: "utf8" });

let n = 0;
function repo(withOrigin = false) {
  const dir = join(root, `r${++n}`);
  mkdirSync(dir);
  g(dir, "init", "-q", "--initial-branch=main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "init");
  let origin: string | null = null;
  if (withOrigin) {
    origin = join(root, `o${n}.git`);
    g(root, "init", "-q", "--bare", "--initial-branch=main", origin);
    g(dir, "remote", "add", "origin", origin);
    g(dir, "push", "-q", "-u", "origin", "main");
  }
  return { dir, origin };
}

function setup(dir: string) {
  const deps = testDeps();
  const projects = new Map<string, ProjectRef>([["p", { name: "p", path: dir } as ProjectRef]]);
  const services = stubServices({
    projects: { get: (name: string) => projects.get(name) ?? null } as never,
    sessions: { get: (id: string) => (id === "s1" ? ({ id, cwd: dir } as Session) : null), list: () => [] } as never,
  });
  return { git: createGitService(deps, services), deps };
}
const P: GitTarget = { kind: "project", id: "p" };
const S: GitTarget = { kind: "session", id: "s1" };
const code = async (p: Promise<unknown>) => p.then(() => null, (e) => (e instanceof HttpError ? `${e.status}${e.code ? ` ${e.code}` : ""}` : String(e)));

describe("git service", () => {
  it("reports staged, unstaged and untracked files with line counts", async () => {
    const { dir } = repo();
    const { git } = setup(dir);
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    writeFileSync(join(dir, "new.txt"), "x\ny\n");
    const s = await git.status(S);
    assert.equal(s.repo, true);
    assert.equal(s.branch, "main");
    assert.deepEqual(s.unstaged.map(c => [c.path, c.state, c.additions, c.deletions]), [["a.txt", "modified", 1, 1], ["new.txt", "untracked", 2, 0]]);
    assert.equal(s.staged.length, 0);
  });

  it("answers repo:false outside a repo and rejects bad paths", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    const { git } = setup(dir);
    assert.equal((await git.status(P)).repo, false);
    assert.equal(await code(git.stage(P, { paths: ["a"] })), "409 not-a-repo");
    assert.throws(() => cleanRelPath("../x"), HttpError);
    assert.throws(() => cleanRelPath("/etc/passwd"), HttpError);
    assert.throws(() => cleanRelPath("--force"), HttpError);
    assert.equal(cleanRelPath("src\\a.ts"), "src/a.ts");
  });

  it("stages and unstages one hunk, and a few lines of one", async () => {
    const { dir } = repo();
    const { git, deps } = setup(dir);
    writeFileSync(join(dir, "a.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\neleven\n");
    const d = await git.diff(S, "a.txt", false);
    assert.equal(d.hunks.length, 2);
    await git.stage(S, { hunks: [{ path: "a.txt", hunkId: d.hunks[1]!.id }] });
    const staged = await git.diff(S, "a.txt", true);
    assert.equal(staged.hunks.length, 1);
    assert.deepEqual(staged.hunks[0]!.lines.filter(l => l.kind !== "context").map(l => l.kind + l.text), ["delten", "addTEN", "addeleven"]);
    assert.ok(deps.events.some(e => e.type === "git.changed"));

    await git.unstage(S, { hunks: [{ path: "a.txt", hunkId: staged.hunks[0]!.id, lines: staged.hunks[0]!.lines.findIndex(l => l.text === "eleven") === -1 ? [] : [staged.hunks[0]!.lines.findIndex(l => l.text === "eleven")] }] });
    const after = await git.diff(S, "a.txt", true);
    assert.deepEqual(after.hunks[0]!.lines.filter(l => l.kind !== "context").map(l => l.kind + l.text), ["delten", "addTEN"]);
    // The file on disk is untouched by staging.
    assert.match(readFileSync(join(dir, "a.txt"), "utf8"), /eleven/);
  });

  it("refuses a stale hunk id", async () => {
    const { dir } = repo();
    const { git } = setup(dir);
    writeFileSync(join(dir, "a.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n");
    assert.equal(await code(git.stage(S, { hunks: [{ path: "a.txt", hunkId: "1,1:deadbeef00" }] })), "409 conflict");
  });

  it("discards whole files into a stash, and single hunks in place", async () => {
    const { dir } = repo();
    const { git } = setup(dir);
    writeFileSync(join(dir, "a.txt"), "ONE\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nTEN\n");
    writeFileSync(join(dir, "junk.txt"), "j\n");
    const d = await git.diff(S, "a.txt", false);
    await git.discard(S, { hunks: [{ path: "a.txt", hunkId: d.hunks[0]!.id }] });
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8").startsWith("one\n"), true);
    await git.discard(S, { paths: ["a.txt", "junk.txt"] });
    const s = await git.status(S);
    assert.equal(s.unstaged.length, 0);
    const stashes = await git.stashes(S);
    assert.equal(stashes.length, 1);
    assert.match(stashes[0]!.message, /^odin-discard: 2 files/);
  });

  it("commits, logs with session trailers, shows and blames", async () => {
    const { dir } = repo();
    const { git } = setup(dir);
    writeFileSync(join(dir, "b.txt"), "hello\n");
    assert.equal(await code(git.commit(S, { message: "nothing" })), "409 nothing-to-commit");
    const r = await git.commit(S, { message: "feat: add b\n\nBody line.\n\nOdin-Session: s1\nOdin-Turns: 2-3", all: true });
    assert.equal(r.status.unstaged.length, 0);
    const log = await git.log(S, { limit: 1 });
    assert.equal(log.more, true);
    assert.equal(log.commits[0]!.subject, "feat: add b");
    assert.equal(log.commits[0]!.sessionId, "s1");
    assert.equal(log.commits[0]!.turns, "2-3");
    assert.equal(log.commits[0]!.additions, 1);
    const fileLog = await git.log(S, { path: "a.txt" });
    assert.deepEqual(fileLog.commits.map(c => c.subject), ["init"]);
    const show = await git.show(S, r.sha);
    assert.deepEqual(show.files.map(f => [f.path, f.state]), [["b.txt", "added"]]);
    const blame = await git.blame(S, "b.txt");
    assert.equal(blame.ranges.length, 1);
    assert.equal(blame.commits[blame.ranges[0]!.sha]!.sessionId, "s1");
  });

  it("lists branches, refuses a dirty switch, stashes and restores on return", async () => {
    const { dir } = repo();
    const { git } = setup(dir);
    g(dir, "branch", "feat/x");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const b = await git.branches(S);
    assert.deepEqual(b.branches.filter(x => !x.remote).map(x => x.name).sort(), ["feat/x", "main"]);
    assert.equal(b.current, "main");
    assert.equal(await code(git.checkout(S, { branch: "feat/x" })), "409 dirty-tree");
    const out = await git.checkout(S, { branch: "feat/x", dirty: "stash" });
    assert.equal(out.branch, "feat/x");
    assert.ok(out.stashed);
    assert.equal(out.status.unstaged.length, 0);
    const back = await git.checkout(S, { branch: "main" });
    assert.equal(back.restored, true);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "changed\n");
    assert.equal((await git.stashes(S)).length, 0);
    assert.equal(await code(git.checkout(S, { branch: "-rf" })), "400");
  });

  it("creates a branch, pushes with upstream, fetches, and pulls a remote commit", async () => {
    const { dir, origin } = repo(true);
    const { git } = setup(dir);
    await git.checkout(S, { branch: "feat/y", create: true });
    writeFileSync(join(dir, "y.txt"), "y\n");
    await git.commit(S, { message: "y", all: true });
    const pushed = await git.push(S, {});
    assert.equal(pushed.message, "Pushed 1 commit");
    assert.equal(pushed.status.upstream, "origin/feat/y");

    // Someone else pushes to main; fetch sees it and a fast-forward pull brings it in.
    const other = join(root, `clone${n}`);
    g(root, "clone", "-q", origin!, other);
    writeFileSync(join(other, "z.txt"), "z\n");
    g(other, "add", "-A");
    g(other, "commit", "-q", "-m", "z");
    g(other, "push", "-q", "origin", "main");
    await git.checkout(S, { branch: "main" });
    const fetched = await git.fetch(S);
    assert.equal(fetched.status.behind, 1);
    const pulled = await git.pull(S, { strategy: "ff-only" });
    assert.equal(pulled.message, "Pulled 1 commit");
    assert.equal(pulled.status.behind, 0);
  });

  it("answers diverged when a fast-forward pull can't work", async () => {
    const { dir, origin } = repo(true);
    const { git } = setup(dir);
    const other = join(root, `clone${n}`);
    g(root, "clone", "-q", origin!, other);
    writeFileSync(join(other, "z.txt"), "z\n");
    g(other, "add", "-A");
    g(other, "commit", "-q", "-m", "z");
    g(other, "push", "-q", "origin", "main");
    writeFileSync(join(dir, "mine.txt"), "m\n");
    await git.commit(S, { message: "mine", all: true });
    await git.fetch(S);
    const incoming = await git.log(S, { ref: "HEAD..@{u}" });
    assert.deepEqual(incoming.commits.map((c) => c.subject), ["z"]);
    const outgoing = await git.log(S, { ref: "@{u}..HEAD" });
    assert.deepEqual(outgoing.commits.map((c) => c.subject), ["mine"]);
    assert.equal(await code(git.log(S, { ref: "HEAD...--all" })), "400");
    assert.equal(await code(git.pull(S, { strategy: "ff-only" })), "409 diverged");
    const rebased = await git.pull(S, { strategy: "rebase" });
    assert.equal(rebased.status.ahead, 1);
    assert.equal(rebased.status.behind, 0);
  });
});

describe("git actions", () => {
  const define = (dir: string, id: string, def: object) => {
    mkdirSync(join(dir, ".odin", "git-actions"), { recursive: true });
    writeFileSync(join(dir, ".odin", "git-actions", `${id}.json`), JSON.stringify(def));
  };
  const node = process.execPath;

  it("lists definitions, flags bad ones, and runs one with $STAGED expanded", async () => {
    const { dir } = repo();
    const { git } = setup(dir);
    define(dir, "echo", { title: "Echo staged", on: "manual", run: [node, "-e", "console.log(process.argv.slice(1).join(','))", "$STAGED"] });
    define(dir, "broken", { on: "sometimes", run: "rm -rf /" });
    writeFileSync(join(dir, "b.txt"), "b\n");
    g(dir, "add", "b.txt");
    const actions = await git.actions(P);
    assert.deepEqual(actions.map((a) => [a.id, a.error === null]), [["broken", false], ["echo", true]]);
    assert.equal(await code(git.runAction(P, "broken")), "400");
    const run = await git.runAction(P, "echo");
    assert.equal(run.ok, true);
    assert.equal(run.output.trim(), "b.txt");
    assert.deepEqual(run.command.slice(-1), ["b.txt"]);
    assert.equal((await git.actions(P)).find((a) => a.id === "echo")?.lastRun?.ok, true);
  });

  it("blocks a commit when a blocking pre-commit action fails, and commits anyway when asked", async () => {
    const { dir } = repo();
    const { git } = setup(dir);
    define(dir, "tests", { title: "Run tests", on: "pre-commit", run: [node, "-e", "console.error('1 failed'); process.exit(1)"] });
    define(dir, "lint", { title: "Lint", on: "pre-commit", blocking: false, enabled: false, run: [node, "-e", "process.exit(1)"] });
    writeFileSync(join(dir, "a.txt"), "changed\n");
    assert.equal(await code(git.commit(S, { message: "x", all: true })), "409 action-failed");
    const tests = (await git.actions(S)).find((a) => a.id === "tests")!;
    assert.equal(tests.lastRun?.ok, false);
    assert.equal(tests.lastRun?.exitCode, 1);
    assert.match(tests.lastRun!.output, /1 failed/);
    assert.equal((await git.actions(S)).find((a) => a.id === "lint")?.lastRun, null);
    const done = await git.commit(S, { message: "x", skipActions: true });
    assert.equal(done.status.staged.length, 0);
  });
});
