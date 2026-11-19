import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeSessions, makeSession, routeApp } from "../ingest/fakes.ts";
import { stubServices, testDeps, tempDir, removeTempDir } from "../test-helpers.ts";
import { createMetricsService, parseNumstat } from "./service.ts";
import { registerMetricsRoutes } from "./routes.ts";
import type { Services } from "../services.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function repo() {
  const dir = tempDir("odin-metrics-");
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feature");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour\n");
  writeFileSync(join(dir, "b.txt"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "work");
  writeFileSync(join(dir, "c.txt"), "y\ny\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "more");
  // Main moves on after the branch point: the merge base keeps that out of the diff.
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "main-only.txt"), "z\n".repeat(50));
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "main moves");
  return dir;
}

test("parseNumstat counts lines and files, binary files count as files only", () => {
  assert.deepEqual(parseNumstat("2\t1\ta.txt\n-\t-\timg.png\n\n"), { added: 2, removed: 1, files: 2 });
});

test("refreshOutput uses a configured nonstandard default even when main exists", async () => {
  const dir = repo();
  const deps = testDeps();
  try {
    git(dir, "branch", "develop", "feature~1");
    const sessions = fakeSessions(deps.db, [makeSession({ id: "s", cwd: dir, branch: "feature" })]);
    const projects = { get: () => ({ settings: { defaultBranch: "develop" } }) } as unknown as Services["projects"];
    await createMetricsService(deps, stubServices({ sessions, projects })).refreshOutput("s");
    assert.equal(sessions.records.get("s")!.metrics.commits, 1);
    assert.deepEqual(sessions.records.get("s")!.metrics.diff, { added: 2, removed: 0, files: 1 });
    git(dir, "checkout", "-q", "develop");
    git(dir, "branch", "-D", "main");
    await createMetricsService(deps, stubServices({ sessions, projects })).refreshOutput("s");
    assert.equal(sessions.records.get("s")!.metrics.commits, 1);
  } finally { deps.db.close(); removeTempDir(dir); }
});

test("refreshOutput writes diff and commits against the merge base, and leaves the repo alone", async () => {
  const dir = repo();
  try {
    const deps = testDeps();
    const sessions = fakeSessions(deps.db, [makeSession({ id: "s", cwd: dir, branch: "feature" })]);
    const metrics = createMetricsService(deps, stubServices({ sessions, projects: { get: () => ({ settings: { defaultBranch: "main" } }) } as unknown as Services["projects"] }));
    const head = git(dir, "rev-parse", "HEAD");
    await metrics.refreshOutput("s");
    const m = sessions.records.get("s")!.metrics;
    assert.deepEqual(m.diff, { added: 5, removed: 0, files: 3 });
    assert.equal(m.commits, 2);
    assert.equal(git(dir, "rev-parse", "HEAD"), head);
    assert.equal(git(dir, "status", "--porcelain"), "");
    // Unchanged output does not patch again.
    const patches = sessions.patches.length;
    await metrics.refreshOutput("s");
    assert.equal(sessions.patches.length, patches);
  } finally {
    removeTempDir(dir);
  }
});

test("refreshOutput prefers origin/<default> when it exists", async () => {
  const dir = repo();
  try {
    git(dir, "update-ref", "refs/remotes/origin/main", "main~1"); // origin/main is the initial commit
    const deps = testDeps();
    const sessions = fakeSessions(deps.db, [makeSession({ id: "s", cwd: dir, branch: "feature" })]);
    await createMetricsService(deps, stubServices({ sessions, projects: { get: () => ({ settings: { defaultBranch: "main" } }) } as unknown as Services["projects"] })).refreshOutput("s");
    assert.equal(sessions.records.get("s")!.metrics.commits, 2);
  } finally {
    removeTempDir(dir);
  }
});

test("refreshOutput skips sessions without a branch, with a missing path or an unknown branch, and never throws", async () => {
  const dir = repo();
  const missing = join(dir, "nope");
  try {
    const deps = testDeps();
    const sessions = fakeSessions(deps.db, [
      makeSession({ id: "nobranch", cwd: dir, branch: null }),
      makeSession({ id: "nopath", cwd: missing, branch: "feature" }),
      makeSession({ id: "nobranchref", cwd: dir, branch: "ghost" }),
      makeSession({ id: "--oops", cwd: dir, branch: "--output=x" }),
    ]);
    const metrics = createMetricsService(deps, stubServices({ sessions, projects: { get: () => ({ settings: { defaultBranch: "main" } }) } as unknown as Services["projects"] }));
    for (const id of ["nobranch", "nopath", "nobranchref", "--oops", "unknown"]) await metrics.refreshOutput(id);
    assert.equal(sessions.patches.length, 0);
    const notRepo = tempDir("odin-notrepo-");
    mkdirSync(join(notRepo, "x"));
    sessions.records.set("nopath", { ...sessions.records.get("nopath")!, cwd: notRepo });
    await metrics.refreshOutput("nopath");
    assert.equal(sessions.patches.length, 0);
    removeTempDir(notRepo);
  } finally {
    removeTempDir(dir);
  }
});

test("query validates groupBy and since, filters project and since, and excludes archived", async () => {
  const deps = testDeps();
  const a = makeSession({ id: "a", project: "p1", updatedAt: "2026-10-01T00:00:00.000Z" });
  const sessions = fakeSessions(deps.db);
  const rec = (x: typeof a, turns = 1) => sessions.records.set(x.id, { ...x, metrics: { ...x.metrics, turns } });
  rec(a);
  rec({ ...a, id: "b", project: "p2", updatedAt: "2026-10-10T00:00:00.000Z" });
  rec({ ...a, id: "c", project: "p2", archived: true });
  const services = stubServices({ sessions, projects: { get: () => ({ settings: { defaultBranch: "main" } }) } as unknown as Services["projects"] });
  const metrics = createMetricsService(deps, services);
  assert.throws(() => metrics.query({ groupBy: ["model", "model"] }), /groupBy/);
  assert.throws(() => metrics.query({ groupBy: ["model", "agent", "origin", "project"] }), /groupBy/);
  assert.throws(() => metrics.query({ groupBy: ["bogus" as never] }), /groupBy/);
  assert.throws(() => metrics.query({ groupBy: ["project"], since: "yesterday-ish" }), /since/);
  assert.equal(metrics.query({ groupBy: ["project"] }).length, 2);
  assert.deepEqual(metrics.query({ groupBy: ["project"], since: "2026-10-05T00:00:00Z" }).flatMap((r) => r.sessionIds), ["b"]);
  assert.deepEqual(metrics.query({ groupBy: ["project"], project: "p2" }).map((r) => r.sessionIds), [["b"]]);
});

test("GET /api/metrics passes the query through; no groupBy means one ungrouped row", async () => {
  const calls: unknown[] = [];
  const services = stubServices({ metrics: { query: (q: unknown) => (calls.push(q), []) } as unknown as Services["metrics"] });
  const a = await routeApp(registerMetricsRoutes, testDeps(), services);
  try {
    assert.deepEqual(await (await a.fetch("/api/metrics?groupBy=model,template&project=p&since=2026-10-01T00:00:00Z&until=2026-10-08T00:00:00Z")).json(), []);
    assert.equal((await a.fetch("/api/metrics")).status, 200);
    assert.deepEqual(calls, [
      { groupBy: ["model", "template"], project: "p", since: "2026-10-01T00:00:00Z", until: "2026-10-08T00:00:00Z" },
      { groupBy: [] },
    ]);
  } finally {
    await a.close();
  }
});

test("query: until, totals and the single ungrouped row", () => {
  const deps = testDeps();
  const base = makeSession({ id: "a", project: "p1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z" });
  const sessions = fakeSessions(deps.db);
  const rec = (x: typeof base, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }, costUsd: number | null) =>
    sessions.records.set(x.id, { ...x, metrics: { ...x.metrics, turns: 1, tokens, costUsd } });
  rec(base, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, 0.5);
  rec({ ...base, id: "b", createdAt: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-06T00:00:00.000Z" }, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, null);
  rec({ ...base, id: "c", createdAt: "2026-10-09T00:00:00.000Z", updatedAt: "2026-10-09T00:00:00.000Z" }, { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 }, 1.25);
  const metrics = createMetricsService(deps, stubServices({ sessions }));
  const all = metrics.query({ groupBy: [] });
  assert.equal(all.length, 1);
  assert.deepEqual(all[0]!.key, {});
  assert.equal(all[0]!.n, 3);
  assert.deepEqual(all[0]!.total, { tokens: { input: 111, output: 22, cacheRead: 33, cacheWrite: 44 }, costUsd: 1.75 });
  const window = metrics.query({ groupBy: [], since: "2026-10-03T00:00:00Z", until: "2026-10-08T00:00:00Z" });
  assert.deepEqual(window.map((r) => [r.sessionIds, r.total.costUsd]), [[["b"], null]]);
  const none = metrics.query({ groupBy: [], project: "nobody" });
  assert.equal(none.length, 1);
  assert.equal(none[0]!.n, 0);
  assert.deepEqual(none[0]!.total, { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null });
  assert.deepEqual(metrics.query({ groupBy: ["project"], project: "nobody" }), []);
  assert.throws(() => metrics.query({ groupBy: [], until: "soon" }), /until/);
});
