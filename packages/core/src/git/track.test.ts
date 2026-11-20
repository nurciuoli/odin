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

function tempRepo() {
  const root = tempDir("odin-track-");
  const path = join(root, "demo");
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
