// Branch tracking and git.changed fan-out through the real app: temp repos, the fake harness, real fs watchers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@odin/shared/api";
import type { ServerEvent } from "@odin/shared/events";
import { fakeHarness } from "../harness/fake.ts";
import { startApp, tempDir, removeTempDir, waitFor, watchEvents, type TestApp } from "../test-helpers.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function tempRepo(name = "demo") {
  const root = tempDir("odin-track-");
  const path = join(root, name);
  mkdirSync(path);
  git(path, "init", "-q", "-b", "main");
  writeFileSync(join(path, "README.md"), "# demo\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "init");
  return { path, cleanup: () => removeTempDir(root) };
}

const post = (app: TestApp, path: string, body?: unknown) => app.api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const branchOf = (app: TestApp, id: string) => async () => (await app.json<Session>(`/api/sessions/${id}`)).branch;
const changedTargets = (events: ServerEvent[]) => new Set(events.flatMap((e) => (e.type === "git.changed" ? [`${e.target.kind}:${e.target.id}`] : [])));

async function setup() {
  const repo = tempRepo();
  const app = await startApp({ harnesses: { claude: fakeHarness() } });
  assert.equal((await post(app, "/api/projects", { path: repo.path })).status, 201);
  const ids: string[] = [];
  for (const text of ["one", "two"]) {
    const s = (await (await post(app, "/api/sessions", { project: "demo", prompt: { text } })).json()) as Session;
    ids.push(s.id);
  }
  await waitFor(async () => (await Promise.all(ids.map((id) => app.json<Session>(`/api/sessions/${id}`)))).every((s) => s.state === "idle"), 3000, "idle");
  return { repo, app, ids, done: async () => { await app.close(); repo.cleanup(); } };
}

test("a checkout through the route updates the branch of every session in the folder and refreshes all targets", async () => {
  const { app, ids, done } = await setup();
  try {
    const want = ["project:demo", ...ids.map((id) => `session:${id}`)];
    const w = watchEvents(app.base, (ev) => want.every((t) => changedTargets(ev).has(t)), 4000);
    await w.connected;
    const res = await post(app, `/api/sessions/${ids[0]}/git/checkout`, { branch: "feat/x", create: true });
    assert.equal(res.status, 200);
    const targets = changedTargets(await w.events);
    for (const t of want) assert.ok(targets.has(t), `git.changed for ${t}`);
    for (const id of ids) assert.equal(await branchOf(app, id)(), "feat/x");
  } finally {
    await done();
  }
});

test("a branch switched outside Odin is picked up by the watcher", async () => {
  const { repo, app, ids, done } = await setup();
  try {
    const want = ["project:demo", ...ids.map((id) => `session:${id}`)];
    const w = watchEvents(app.base, (ev) => want.every((t) => changedTargets(ev).has(t)), 5000);
    await w.connected;
    git(repo.path, "checkout", "-q", "-b", "agent/work");
    await waitFor(async () => (await Promise.all(ids.map((id) => branchOf(app, id)()))).every((b) => b === "agent/work"), 5000, "branch refresh");
    const targets = changedTargets(await w.events);
    for (const t of want) assert.ok(targets.has(t), `git.changed for ${t}`);
    git(repo.path, "checkout", "-q", "--detach");
    await waitFor(async () => (await branchOf(app, ids[0]!)()) === null, 5000, "detached");
  } finally {
    await done();
  }
});

test("a session in a subdirectory follows the checkout, including a switch made outside Odin", async () => {
  const repo = tempRepo();
  const app = await startApp({ harnesses: { claude: fakeHarness() } });
  try {
    assert.equal((await post(app, "/api/projects", { path: repo.path })).status, 201);
    const sub = join(repo.path, "src");
    mkdirSync(sub);
    const ev = [{ id: "e-sub", harness: "claude-code", session: "term-sub", cwd: sub, branch: "stale", ts: "2026-11-11T00:00:00.000Z", kind: "turn", data: { index: 1, durationMs: 1000 } }];
    const send = await app.api("/api/ingest", { method: "POST", body: JSON.stringify(ev), headers: { authorization: "Bearer test-ingest-token" } });
    assert.equal(send.status, 200);
    const status = await app.json<{ repo: boolean; branch: string | null }>("/api/sessions/term-sub/git/status");
    assert.equal(status.repo, true);
    assert.equal(status.branch, "main");
    const switched = await post(app, "/api/sessions/term-sub/git/checkout", { branch: "feat/via-route", create: true });
    assert.equal(switched.status, 200);
    assert.equal(await branchOf(app, "term-sub")(), "feat/via-route");
    const want = ["project:demo", "session:term-sub"];
    const w = watchEvents(app.base, (events) => want.every((t) => changedTargets(events).has(t)), 5000);
    await w.connected;
    git(repo.path, "checkout", "-q", "-b", "from-root");
    await waitFor(async () => (await branchOf(app, "term-sub")()) === "from-root", 5000, "subdir branch");
    const targets = changedTargets(await w.events);
    for (const t of want) assert.ok(targets.has(t), `git.changed for ${t}`);
  } finally {
    await app.close();
    repo.cleanup();
  }
});

test("a project with no live session still announces a branch switch", async () => {
  const repo = tempRepo("solo");
  const app = await startApp({ harnesses: { claude: fakeHarness() } });
  try {
    assert.equal((await post(app, "/api/projects", { path: repo.path })).status, 201);
    const w = watchEvents(app.base, (events) => changedTargets(events).has("project:solo"), 5000);
    await w.connected;
    git(repo.path, "checkout", "-q", "-b", "quiet");
    const targets = changedTargets(await w.events);
    assert.ok(targets.has("project:solo"));
  } finally {
    await app.close();
    repo.cleanup();
  }
});

test("a session's other repository is announced without changing the working branch", async () => {
  const demo = tempRepo("demo");
  const other = tempRepo("other");
  const app = await startApp({ harnesses: { claude: fakeHarness() } });
  try {
    assert.equal((await post(app, "/api/projects", { path: demo.path })).status, 201);
    assert.equal((await post(app, "/api/projects", { path: other.path })).status, 201);
    const started = (await (await post(app, "/api/sessions", { project: "demo", projects: ["demo", "other"], prompt: { text: "across" } })).json()) as Session;
    await waitFor(async () => (await app.json<Session>(`/api/sessions/${started.id}`)).state === "idle", 3000, "idle");
    const before = await branchOf(app, started.id)();
    const want = ["project:other", `session:${started.id}`];
    const w = watchEvents(app.base, (events) => want.every((t) => changedTargets(events).has(t)), 4000);
    await w.connected;
    const res = await post(app, "/api/projects/other/git/checkout", { branch: "side", create: true });
    assert.equal(res.status, 200);
    const targets = changedTargets(await w.events);
    for (const t of want) assert.ok(targets.has(t), `git.changed for ${t}`);
    assert.equal(await branchOf(app, started.id)(), before);
  } finally {
    await app.close();
    demo.cleanup();
    other.cleanup();
  }
});

test("ingest updates the stored branch when the reported one differs", async () => {
  const { repo, app, done } = await setup();
  try {
    const ev = (branch: string, index: number) => [{ id: `e-${branch}`, harness: "claude-code", session: "term-9", cwd: repo.path, branch, ts: "2026-11-11T00:00:00.000Z", kind: "turn", data: { index, durationMs: 1000 } }];
    const send = (body: unknown) => app.api("/api/ingest", { method: "POST", body: JSON.stringify(body), headers: { authorization: "Bearer test-ingest-token" } });
    assert.equal((await send(ev("one", 1))).status, 200);
    assert.equal(await branchOf(app, "term-9")(), "one");
    assert.equal((await send(ev("two", 2))).status, 200);
    assert.equal(await branchOf(app, "term-9")(), "two");
  } finally {
    await done();
  }
});
