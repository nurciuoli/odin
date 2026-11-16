import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotJournal, startupController } from "./reconcile.ts";
import { countsStore, type SessionLite } from "./counts.ts";

test("a stale desktop snapshot cannot remove sessions or restore a removed session", () => {
  const counts = countsStore();
  const journal = snapshotJournal<{ session?: SessionLite; removed?: string }>();
  const apply = (event: { session?: SessionLite; removed?: string }) => {
    if (event.session) counts.update(event.session);
    if (event.removed) counts.remove(event.removed);
  };
  const token = journal.begin();
  const started = { session: { id: "new", title: "New", state: "waiting" } };
  journal.observe(started); apply(started);
  const removed = { removed: "old" };
  journal.observe(removed); apply(removed);
  journal.complete(token, () => counts.seed([{ id: "old", title: "Old", state: "running" }]), apply);
  assert.equal(counts.get("old"), undefined);
  assert.equal(counts.counts().waiting, 1);
  assert.equal(counts.counts().running, 0);
});

test("overlapping snapshots reject old completions and preserve newer task events", () => {
  const journal = snapshotJournal<string>();
  const a = journal.begin();
  const b = journal.begin();
  journal.observe("completed");
  const states: string[] = [];
  assert.equal(journal.complete(a, () => states.push("old"), e => states.push(e)), false);
  journal.complete(b, () => states.push("running"), e => states.push(e));
  assert.deepEqual(states, ["running", "completed"]);
});

test("retry after a port conflict initializes IPC once and serializes restart clicks", async () => {
  let init = 0;
  let connect = 0;
  let occupied = true;
  const run = startupController(() => { init++; }, async () => {
    connect++;
    if (occupied) throw new Error("port occupied");
  });
  await assert.rejects(run(), /port occupied/);
  occupied = false;
  await Promise.all([run(), run()]);
  assert.equal(init, 1);
  assert.equal(connect, 2);
});
