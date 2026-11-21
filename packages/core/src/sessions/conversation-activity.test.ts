import assert from "node:assert/strict";
import { test } from "node:test";
import { createIngestService } from "../ingest/service.ts";
import { PROJECT, setup, waitFor } from "./test-setup.ts";

const historicalAt = "2026-10-01T12:00:00.000Z";
const turnAt = "2026-10-17T12:00:00.000Z";
const laterAt = "2026-10-17T12:10:00.000Z";

test("running an imported session advances activity while metadata changes leave it alone", async () => {
  const s = setup();
  const id = "imported";
  try {
    s.harness.seed({ sessionId: id, cwd: s.projectPath, updatedAt: historicalAt });
    s.sessions.ensureExternal({ id, harness: "claude", project: PROJECT, cwd: s.projectPath, at: historicalAt, activityAt: null });
    assert.equal((await s.sessions.update(id, { title: "Historical session" })).activityAt, null);

    s.deps.now = () => new Date(turnAt);
    await s.sessions.send(id, { text: "New work" });
    await waitFor(() => s.sessions.get(id)?.state === "idle");
    assert.equal((await s.sessions.detail(id))?.activityAt, turnAt);
    assert.ok(s.deps.events.some(event => event.type === "session.updated" && event.session.id === id && event.session.activityAt === turnAt));

    s.deps.now = () => new Date(laterAt);
    const session = await s.sessions.update(id, { pinned: true, tags: ["project"] });
    assert.equal(session.updatedAt, laterAt);
    assert.equal(session.activityAt, turnAt);
    assert.equal((await s.sessions.end(id)).activityAt, turnAt);
  } finally {
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});

test("terminal hooks advance activity for new work and failures, even when events arrive out of order", async () => {
  const s = setup();
  const id = "terminal";
  const ingest = createIngestService(s.deps, s.services);
  try {
    s.sessions.ensureExternal({ id, harness: "claude", project: PROJECT, cwd: s.projectPath, at: historicalAt, activityAt: null });
    const event = { harness: "claude-code", session: id, project: PROJECT };
    assert.equal(ingest.ingest([
      { ...event, id: "start", ts: turnAt, kind: "session.started", data: { source: "resume" } },
      { ...event, id: "end", ts: turnAt, kind: "session.ended", data: { outcome: "completed" } },
    ]).accepted, 2);
    assert.equal(s.sessions.get(id)?.activityAt, null);

    const turn = { ...event, id: "turn", ts: turnAt, kind: "turn", data: { index: 1, durationMs: 100 } };
    assert.equal(ingest.ingest([turn]).accepted, 1);
    assert.equal(s.sessions.get(id)?.activityAt, turnAt);
    assert.equal(ingest.ingest([{ ...turn, id: "delayed", ts: historicalAt }]).accepted, 1);
    assert.equal(s.sessions.get(id)?.activityAt, turnAt);
    assert.equal(s.sessions.get(id)?.updatedAt, turnAt);

    assert.equal(ingest.ingest([
      { ...event, id: "failure", ts: laterAt, kind: "session.ended", data: { outcome: "failed", error: "oops" } },
    ]).accepted, 1);
    assert.equal(s.sessions.get(id)?.activityAt, laterAt);
  } finally {
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});

test("offline detail preserves the activity timestamp from before a racing transcript read", async () => {
  const s = setup();
  const id = "terminal";
  const reading = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    s.sessions.ensureExternal({ id, harness: "claude", project: PROJECT, cwd: s.projectPath, at: historicalAt, activityAt: null });
    s.harness.messages = async () => {
      reading.resolve();
      await release.promise;
      return [];
    };
    const pending = s.sessions.detail(id);
    await reading.promise;
    s.sessions.patch(id, { updatedAt: turnAt, activityAt: turnAt });
    release.resolve();
    assert.equal((await pending)?.activityAt, null);
    assert.equal((await s.sessions.detail(id))?.activityAt, turnAt);
  } finally {
    release.resolve();
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});

test("an imported session stays quiet when a terminal hook backfills turns and cumulative usage", async () => {
  const s = setup();
  const id = "terminal";
  const ingest = createIngestService(s.deps, s.services);
  try {
    s.harness.seed({ sessionId: id, cwd: s.projectPath, updatedAt: historicalAt });
    await s.sessions.discover(PROJECT);
    const event = { harness: "claude-code", session: id, project: PROJECT };
    const historicalTurn = { ...event, id: "turn-1", ts: historicalAt, kind: "turn", data: { index: 1, durationMs: 100 } };
    assert.equal(ingest.ingest([
      historicalTurn,
      { ...event, id: "usage", ts: laterAt, kind: "usage", data: { model: "test", input: 10, output: 5, cumulative: true } },
    ]).accepted, 2);
    assert.equal(s.sessions.get(id)?.activityAt, null);
    assert.equal(s.sessions.get(id)?.metrics.turns, 1);

    assert.equal(ingest.ingest([{ ...historicalTurn, id: "turn-2", ts: laterAt, data: { index: 2, durationMs: 100 } }]).accepted, 1);
    assert.equal(s.sessions.get(id)?.activityAt, laterAt);
  } finally {
    await s.sessions.close();
    s.services.library.close();
    s.deps.db.close();
  }
});
