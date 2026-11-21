import { test } from "node:test";
import assert from "node:assert/strict";
import { countsStore, quitPrompt, trayTooltip, type SessionLite } from "./counts.ts";

const s = (id: string, state: string, extra: Partial<SessionLite> = {}): SessionLite => ({
  id,
  title: `T ${id}`,
  state,
  createdAt: `2026-11-1${id.length}T00:00:00Z`,
  updatedAt: new Date().toISOString(),
  ...extra,
});

test("counts running and waiting; archived and side threads never count", () => {
  const c = countsStore();
  c.seed([s("a", "running"), s("b", "waiting"), s("c", "idle"), s("d", "running", { aside: true }), s("e", "waiting", { archived: true })]);
  assert.deepEqual(c.counts(), { running: 1, waiting: 1, waitingSessions: [{ id: "b", title: "T b" }] });
});

test("an idle session with running background work counts as running, until the work ends", () => {
  const c = countsStore();
  c.seed([s("a", "idle")]);
  assert.deepEqual(c.idleToCheck(Date.now()).map((x) => x.id), ["a"]);
  c.setTasks("a", [{ taskId: "t1", runId: null, state: "running" }, { taskId: "t2", state: "completed" }]);
  assert.equal(c.counts().running, 1);
  c.task("a", { taskId: "t1", runId: null, state: "completed" });
  assert.equal(c.counts().running, 0);
  c.task("zzz", { taskId: "t", state: "running" }); // unknown session: ignored
  assert.equal(c.counts().running, 0);
});

test("a quiet history import only becomes a transcript candidate after recent activity", () => {
  const c = countsStore();
  c.seed([s("imported", "idle", { activityAt: null })]);
  assert.deepEqual(c.idleToCheck(Date.now()), []);
  c.update(s("imported", "idle", { activityAt: new Date().toISOString() }));
  assert.deepEqual(c.idleToCheck(Date.now()).map((x) => x.id), ["imported"]);
});

test("events move sessions between buckets; a reseed replaces everything", () => {
  const c = countsStore();
  c.seed([s("a", "running")]);
  c.update(s("a", "waiting"));
  c.update(s("b", "running"));
  assert.deepEqual([c.counts().running, c.counts().waiting], [1, 1]);
  c.remove("b");
  assert.equal(c.counts().running, 0);
  c.seed([]);
  assert.deepEqual([c.counts().running, c.counts().waiting], [0, 0]);
});

test("waiting sessions are listed newest start first", () => {
  const c = countsStore();
  c.seed([s("x", "waiting", { createdAt: "2026-01-01" }), s("y", "waiting", { createdAt: "2026-02-01" })]);
  assert.deepEqual(c.counts().waitingSessions.map((w) => w.id), ["y", "x"]);
});

test("tooltip and quit prompt", () => {
  assert.equal(trayTooltip({ running: 2, waiting: 1 }), "Odin: 2 running, 1 needs you");
  assert.equal(quitPrompt({ running: 0, waiting: 0 }), null);
  assert.equal(quitPrompt({ running: 1, waiting: 1 }), "2 sessions are live. Quit and stop them?");
  assert.equal(quitPrompt({ running: 0, waiting: 1 }), "1 session is live. Quit and stop it?");
});
