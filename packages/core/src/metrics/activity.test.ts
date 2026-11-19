// MetricsService.activity and GET /api/projects/:name/activity. Days are local calendar days: this file pins TZ.
process.env.TZ = "America/New_York";

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "@odin/shared/api";
import { fakeSessions, makeSession, routeApp } from "../ingest/fakes.ts";
import { createSettingsService } from "../settings/service.ts";
import type { ProjectsService, SessionsService } from "../services.ts";
import { stubServices, testDeps, tempDir, removeTempDir } from "../test-helpers.ts";
import { countCommitsByDay, createMetricsService, localDay } from "./service.ts";
import { registerMetricsRoutes } from "./routes.ts";

// 2026-10-17 08:00 in New York.
const NOW = new Date("2026-10-17T12:00:00Z");

function setup(sessions: Session[], paths: Record<string, string> = {}) {
  const deps = testDeps({ now: () => NOW });
  const fake = fakeSessions(deps.db, sessions);
  // The real list matches the working project or projects[].
  const list = (f: { project?: string; since?: string } = {}) =>
    [...fake.records.values()].filter((s) => (!f.project || s.project === f.project || s.projects.includes(f.project)) && (!f.since || s.updatedAt >= f.since));
  const sessionsService = { ...fake, list } as unknown as SessionsService;
  const services = stubServices({ sessions: sessionsService, projects: { get: (n: string) => (n === "demo" || n === "other" ? { name: n, path: paths[n] } : null) } as unknown as ProjectsService });
  services.settings = createSettingsService(deps, services);
  const metrics = createMetricsService(deps, services);
  services.metrics = metrics;
  let seq = 0;
  const fact = (sessionId: string, kind: string, ts: string, data: object) =>
    deps.db
      .prepare("INSERT INTO session_events (id, seq, session_id, source, kind, ts, data, received_at) VALUES (?, ?, ?, 'harness', ?, ?, ?, ?)")
      .run(`f${++seq}`, seq, sessionId, kind, ts, JSON.stringify(data), ts);
  return { deps, metrics, services, fact };
}

test("localDay uses the local time zone", () => {
  assert.equal(localDay(new Date("2026-10-17T02:00:00Z")), "2026-10-16");
});

test("activity: an empty project gives zero days, oldest first, today last, no gaps", async () => {
  const { metrics } = setup([]);
  const { days } = await metrics.activity("demo", 14);
  assert.equal(days.length, 14);
  assert.equal(days[13].date, "2026-10-17");
  assert.equal(days[0].date, "2026-10-04");
  assert.ok(days.every((d) => d.sessions === 0 && d.activeMs === 0 && d.costUsd === null && d.commits === null && d.added === 0 && d.removed === 0));
  await assert.rejects(metrics.activity("demo", 0), /days/);
  await assert.rejects(metrics.activity("demo", 169), /days/);
  assert.throws(() => metrics.sessionsPerDay("demo", 169), /days/);
  assert.deepEqual(metrics.sessionsPerDay("demo", 3), [0, 0, 0]);
});

test("activity: turns spanning local midnight count on both days; active time and cost per day", async () => {
  const s = makeSession({ id: "a", createdAt: "2026-10-16T03:00:00Z", updatedAt: "2026-10-16T05:00:00Z", archived: true });
  const { metrics, fact } = setup([s]);
  // 2026-10-15 23:30 local, then 2026-10-16 00:30 local.
  fact("a", "turn", "2026-10-16T03:30:00Z", { durationMs: 1000 });
  fact("a", "usage", "2026-10-16T03:30:00Z", { model: "unpriced-model", input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.5 });
  fact("a", "turn", "2026-10-16T04:30:00Z", { durationMs: 2000 });
  fact("a", "usage", "2026-10-16T04:30:00Z", { model: "unpriced-model", input: 2, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.75, cumulative: true });
  const { days } = await metrics.activity("demo", 3);
  assert.deepEqual(days.map((d) => d.date), ["2026-10-15", "2026-10-16", "2026-10-17"]);
  assert.deepEqual(days.map((d) => d.sessions), [1, 1, 0]);
  assert.deepEqual(days.map((d) => d.activeMs), [1000, 2000, 0]);
  assert.equal(days[0].costUsd, 0.5);
  // The cumulative report replaces the earlier one: 0.75 - 0.5.
  assert.equal(days[1].costUsd, 0.25);
  assert.equal(days[2].costUsd, null);
});

test("activity: sessions without turn facts count on their created and updated days; projects[] counts", async () => {
  const s = makeSession({ id: "b", project: "other", projects: ["other", "demo"], createdAt: "2026-10-15T14:00:00Z", updatedAt: "2026-10-17T11:00:00Z" });
  const old = makeSession({ id: "c", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" });
  const { metrics } = setup([s, old]);
  const { days } = await metrics.activity("demo", 3);
  assert.deepEqual(days.map((d) => d.sessions), [1, 0, 1]);
});

test("GET /api/projects/:name/activity: default 84 days, 400 bad days, 404 unknown project", async () => {
  const { deps, services } = setup([]);
  const a = await routeApp(registerMetricsRoutes, deps, services);
  try {
    const ok = await a.fetch("/api/projects/demo/activity");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { days: unknown[] }).days.length, 84);
    assert.equal((await (await a.fetch("/api/projects/demo/activity?days=7")).json() as { days: unknown[] }).days.length, 7);
    for (const bad of ["0", "169", "1.5", "x", "-1"]) assert.equal((await a.fetch(`/api/projects/demo/activity?days=${bad}`)).status, 400, bad);
    assert.equal((await a.fetch("/api/projects/nope/activity")).status, 404);
  } finally {
    await a.close();
  }
});

function commitAt(dir: string, file: string, date: string) {
  writeFileSync(join(dir, file), date);
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env, stdio: "ignore" });
  git("add", ".");
  git("commit", "-q", "-m", file);
}

test("countCommitsByDay buckets author times by local day", () => {
  const counts = countCommitsByDay(`${Date.parse("2026-10-16T03:30:00Z") / 1000}\n${Date.parse("2026-10-16T15:00:00Z") / 1000}\n\nx\n`);
  assert.deepEqual([...counts], [["2026-10-15", 1], ["2026-10-16", 1]]);
});

test("activity: commits from every local branch, once each, per local day; null for non-git folders", async () => {
  const repo = tempDir("odin-activity-git-");
  const plain = tempDir("odin-activity-plain-");
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    commitAt(repo, "old", "2026-01-01T12:00:00Z");
    commitAt(repo, "shared", "2026-10-16T15:00:00Z");
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: repo });
    commitAt(repo, "late", "2026-10-16T03:30:00Z"); // 2026-10-15 23:30 local
    commitAt(repo, "today", "2026-10-17T10:00:00Z");
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });
    commitAt(repo, "main-today", "2026-10-17T11:00:00Z");
    const { metrics } = setup([], { demo: repo, other: plain });
    const { days } = await metrics.activity("demo", 3);
    assert.deepEqual(days.map((d) => d.commits), [1, 1, 2]);
    // Cached: a new commit within the TTL is not seen yet.
    commitAt(repo, "more", "2026-10-17T11:30:00Z");
    assert.deepEqual((await metrics.activity("demo", 3)).days.map((d) => d.commits), [1, 1, 2]);
    assert.deepEqual((await metrics.activity("demo", 1)).days.map((d) => d.commits), [3]);
    assert.deepEqual((await metrics.activity("other", 2)).days.map((d) => d.commits), [null, null]);
  } finally {
    removeTempDir(repo);
    removeTempDir(plain);
  }
});

test("activity: session diff lines count once, on the last active day in the window", async () => {
  const a = makeSession({ id: "a", createdAt: "2026-10-15T14:00:00Z", updatedAt: "2026-10-16T14:00:00Z" });
  const b = makeSession({ id: "b", createdAt: "2026-10-17T11:00:00Z", updatedAt: "2026-10-17T11:00:00Z" });
  const withDiff = (s: Session, added: number, removed: number): Session => ({ ...s, metrics: { ...s.metrics, diff: { added, removed, files: 1 } } });
  const { metrics } = setup([withDiff(a, 10, 4), withDiff(b, 3, 1)]);
  const { days } = await metrics.activity("demo", 3);
  assert.deepEqual(days.map((d) => [d.added, d.removed]), [[0, 0], [10, 4], [3, 1]]);
});
