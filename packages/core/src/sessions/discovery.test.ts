import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fakeHarness } from "../harness/fake.ts";
import { createSessionsService } from "./service.ts";
import { PROJECT, setup } from "./test-setup.ts";

const BEFORE = "2026-10-17T11:00:00.000Z";
const BASELINE = "2026-10-17T12:00:00.000Z";
const LATER = "2026-10-17T13:00:00.000Z";
const LATEST = "2026-10-17T14:00:00.000Z";

test("the initial discovery pass starts without waiting for its first polling interval", async () => {
  const s = setup({ projectsRescanMs: 60_000 });
  try {
    s.harness.seed({ sessionId: "external", cwd: s.projectPath, updatedAt: BEFORE });
    assert.equal(s.sessions.get("external"), null);
    await setImmediate();
    assert.equal(s.sessions.get("external")?.activityAt, null);
  } finally {
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});

test("discovery retains the first baseline through a failing scan and service restart", async t => {
  const s = setup();
  let sessions = s.sessions;
  try {
    s.deps.now = () => new Date(BASELINE);
    const list = s.harness.list;
    s.harness.list = async () => { throw new Error("temporarily unavailable"); };
    const log = t.mock.method(console, "error", () => {});
    assert.equal(await sessions.discover(PROJECT), 0);
    assert.equal(log.mock.callCount(), 1);
    await sessions.close();

    s.deps.now = () => new Date(LATEST);
    s.harness.list = list;
    s.harness.seed({ sessionId: "historical", cwd: s.projectPath, updatedAt: BEFORE });
    s.harness.seed({ sessionId: "new-work", cwd: s.projectPath, updatedAt: LATER });
    s.harness.seed({ sessionId: "undated", cwd: s.projectPath, updatedAt: "unknown" });
    sessions = s.services.sessions = createSessionsService(s.deps, s.services);
    assert.equal(await sessions.discover(PROJECT), 3);
    assert.equal(sessions.get("historical")?.activityAt, null);
    assert.equal(sessions.get("historical")?.updatedAt, BEFORE);
    assert.equal(sessions.get("new-work")?.activityAt, LATER);
    assert.equal(sessions.get("undated")?.activityAt, null);
  } finally {
    await sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});

test("a generated title keeps the timestamps and later native activity can surface", async () => {
  const s = setup();
  try {
    s.deps.now = () => new Date(BASELINE);
    s.harness.seed({ sessionId: "external", cwd: s.projectPath, title: "Untitled session", updatedAt: BEFORE });
    await s.sessions.discover(PROJECT);

    s.deps.now = () => new Date(LATEST);
    s.harness.seed({ sessionId: "external", cwd: s.projectPath, title: "A generated title", updatedAt: LATER });
    await s.sessions.discover(PROJECT);
    assert.equal(s.sessions.get("external")?.title, "A generated title");
    assert.equal(s.sessions.get("external")?.updatedAt, BEFORE);
    assert.equal(s.sessions.get("external")?.activityAt, null);
    await s.sessions.discover(PROJECT);
    assert.equal(s.sessions.get("external")?.activityAt, null);

    s.harness.seed({ sessionId: "external", cwd: s.projectPath, title: "A generated title", updatedAt: LATEST });
    await s.sessions.discover(PROJECT);
    assert.equal(s.sessions.get("external")?.activityAt, LATEST);
  } finally {
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});

test("native title changes stay quiet and metadata edits do not hide later terminal work", async () => {
  const s = setup();
  try {
    s.deps.now = () => new Date(BASELINE);
    s.harness.seed({ sessionId: "external", cwd: s.projectPath, title: "Original name", updatedAt: BEFORE });
    await s.sessions.discover(PROJECT);

    await s.sessions.update("external", { title: "My new name" });
    s.harness.seed({ sessionId: "external", cwd: s.projectPath, title: "My new name", updatedAt: LATER });
    await s.sessions.discover(PROJECT);
    assert.equal(s.sessions.get("external")?.activityAt, null);

    const pinTime = "2026-10-17T15:00:00.000Z";
    s.harness.seed({ sessionId: "external", cwd: s.projectPath, title: "My new name", updatedAt: LATEST });
    s.deps.now = () => new Date(pinTime);
    await s.sessions.update("external", { pinned: true });
    await s.sessions.discover(PROJECT);
    assert.equal(s.sessions.get("external")?.activityAt, LATEST);
    assert.equal(s.sessions.get("external")?.updatedAt, pinTime);
  } finally {
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});

test("overlapping discovery requests share a scan and limit native listings in flight", async () => {
  const s = setup();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let active = 0;
  let peak = 0;
  try {
    s.deps.now = () => new Date(BASELINE);
    const harnesses = [s.harness, ...Array.from({ length: 4 }, (_, i) => fakeHarness({ id: `test-${i}` }))];
    const last = harnesses.at(-1)!;
    for (const harness of harnesses) {
      s.deps.harnesses[harness.id] = harness;
      const list = harness.list;
      harness.list = async path => {
        calls++;
        active++;
        peak = Math.max(peak, active);
        await release.promise;
        active--;
        return list(path);
      };
    }
    const first = s.sessions.discover(PROJECT);
    const second = s.sessions.discover(PROJECT);
    assert.equal(calls, 3);
    s.deps.now = () => new Date(LATEST);
    last.seed({ sessionId: "new-while-queued", cwd: s.projectPath, updatedAt: LATER });
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), [1, 1]);
    assert.equal(s.sessions.get("new-while-queued")?.activityAt, LATER);
    assert.equal(calls, 5);
    assert.equal(peak, 3);
  } finally {
    release.resolve();
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});

test("closing settles discovery requests and discards a late harness result", async () => {
  const s = setup();
  const release = Promise.withResolvers<void>();
  try {
    const list = s.harness.list;
    s.harness.list = async path => {
      await release.promise;
      return list(path);
    };
    s.harness.seed({ sessionId: "late", cwd: s.projectPath });
    const scan = s.sessions.discover(PROJECT);
    await s.sessions.close();
    assert.equal(await scan, 0);
    release.resolve();
    await setImmediate();
    assert.equal(s.sessions.get("late"), null);
  } finally {
    release.resolve();
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});
