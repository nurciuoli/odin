import { test } from "node:test";
import assert from "node:assert/strict";
import { messageOutbox } from "./message-queue.ts";
import { createSessionsService } from "./service.ts";
import { PROJECT, setup, waitFor } from "./test-setup.ts";

test("prioritizing receipts is independent across sessions and keeps normal appends last", async () => {
  const s = setup();
  try {
    const a = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    const b = await s.sessions.start({ project: PROJECT, prompt: { text: "B" } });
    const q = messageOutbox(s.deps.db, () => s.deps.now().toISOString(), () => {});
    for (const id of [a.id, b.id]) {
      q.enqueueNext(id, { text: "first" });
      q.enqueue(id, { text: "second", clientId: "second" });
      q.enqueueNext(id, { text: "second", clientId: "second" });
      q.enqueue(id, { text: "last" });
      assert.deepEqual(q.snapshot(id).messages.map(m => m.message.text), ["second", "first", "last"]);
    }
  } finally { await s.sessions.close(); }
});

test("outbox restart retains attachments, pauses pending work, and never replays uncertain sends", async () => {
  const s = setup();
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.close();
    const outbox = messageOutbox(s.deps.db, () => s.deps.now().toISOString(), () => {});
    const message = { clientId: "once", text: "B", attachments: [{ name: "note.txt", mediaType: "text/plain", data: "private attachment" }] };
    outbox.enqueue(session.id, message);
    const first = outbox.reserve(session.id)!;
    outbox.enqueue(session.id, { clientId: "next", text: "C" });
    const starts = s.harness.starts.length;
    const restarted = createSessionsService(s.deps, s.services);
    try {
      const q = restarted.queue(session.id);
      assert.equal(q.paused, true);
      assert.deepEqual(q.messages.map(m => m.state), ["uncertain", "queued"]);
      assert.deepEqual(q.messages[0]!.message, message);
      await assert.rejects(restarted.resumeQueue(session.id), /resolve uncertain/);
      assert.equal(s.harness.starts.length, starts);
      assert.throws(() => restarted.editQueuedMessage(session.id, first.id, { text: "wrong" }), /no longer/);
      restarted.cancelQueuedMessage(session.id, first.id);
      await restarted.resumeQueue(session.id);
      await waitFor(() => restarted.queue(session.id).messages.length === 0);
      assert.equal(s.harness.starts.at(-1)!.prompt!.text, "C");
      assert.equal(outbox.duplicate(session.id, message), true);
      const stored = s.deps.db.prepare("SELECT payload, request_hash FROM session_messages WHERE id = ?").get(first.id) as { payload: string; request_hash: string };
      assert.equal(stored.payload, "{}");
      assert.equal(stored.request_hash.length, 64);
    } finally { await restarted.close(); }
  } finally { await s.sessions.close(); }
});

test("outbox editing preserves receipt identity; reservation wins cancellation and edit races", async () => {
  const s = setup();
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    const outbox = messageOutbox(s.deps.db, () => s.deps.now().toISOString(), () => {});
    const original = { text: "B", clientId: "original" };
    outbox.enqueue(session.id, original);
    const id = outbox.snapshot(session.id).messages[0]!.id;
    outbox.edit(session.id, id, { text: "edited", clientId: "forged" });
    assert.equal(outbox.snapshot(session.id).messages[0]!.message.clientId, "original");
    assert.equal(outbox.duplicate(session.id, original), true);
    assert.throws(() => outbox.duplicate(session.id, { text: "edited", clientId: "original" }), /different content/);
    assert.equal(outbox.reserve(session.id)!.id, id);
    assert.equal(outbox.reserve(session.id), null);
    assert.throws(() => outbox.cancel(session.id, id), /no longer/);
    assert.throws(() => outbox.edit(session.id, id, { text: "late" }), /no longer/);
    outbox.settle(session.id, true);
    assert.equal(outbox.duplicate(session.id, original), true);
    assert.deepEqual(outbox.snapshot(session.id).messages, []);
  } finally { await s.sessions.close(); }
});

test("failure holds older work when a new message is sent, and explicit resume preserves order", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 0 ? [
    { wait: gate },
    { emit: { type: "turn.end", durationMs: 1, ok: false, error: "usage limit" } },
  ] : [{ text: "Done" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await s.sessions.send(session.id, { text: "B", clientId: "b" });
    release();
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.send(session.id, { text: "C", clientId: "c" });
    assert.equal(s.sessions.queue(session.id).paused, true);
    assert.deepEqual(s.sessions.queue(session.id).messages.map(m => m.message.text), ["B", "C"]);
    assert.equal(s.harness.handles.get(session.id)!.sent.length, 1);
    await s.sessions.resumeQueue(session.id);
    await waitFor(() => s.sessions.queue(session.id).messages.length === 0);
    assert.deepEqual(s.harness.handles.get(session.id)!.sent.map(m => m.text), ["A", "B", "C"]);
  } finally { release(); await s.sessions.close(); }
});

test("send now stops the current follow-up and delivers the next message", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 1 ? [{ wait: gate }] : [{ text: "Done" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.send(session.id, { text: "B" });
    await waitFor(() => s.sessions.queue(session.id).messages.some(m => m.state === "sending"));
    await s.sessions.send(session.id, { text: "C" });
    await s.sessions.sendNow(session.id);
    release();
    await waitFor(() => s.harness.handles.get(session.id)!.sent.some(m => m.text === "C"));
    assert.equal(s.sessions.queue(session.id).messages.some(m => m.state === "uncertain"), false);
    await waitFor(() => s.sessions.queue(session.id).messages.length === 0);
    assert.deepEqual(s.harness.handles.get(session.id)!.sent.map(m => m.text), ["A", "B", "C"]);
  } finally { release(); await s.sessions.close(); }
});

test("send now on a paused queue delivers only the next message", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 0 ? [{ wait: gate }] : [{ text: "Done" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "running");
    await s.sessions.send(session.id, { text: "B" });
    await s.sessions.send(session.id, { text: "C" });
    await s.sessions.interrupt(session.id);
    release();
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    assert.equal(s.sessions.queue(session.id).paused, true);
    await s.sessions.sendNow(session.id);
    await waitFor(() => s.harness.handles.get(session.id)!.sent.some(m => m.text === "B"));
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    assert.deepEqual(s.sessions.queue(session.id).messages.map(m => [m.message.text, m.state]), [["C", "queued"]]);
    assert.equal(s.sessions.queue(session.id).paused, true);
    assert.deepEqual(s.harness.handles.get(session.id)!.sent.map(m => m.text), ["A", "B"]);
  } finally { release(); await s.sessions.close(); }
});

test("send now places the given message ahead of queued work", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 0 ? [{ wait: gate }] : [{ text: "Done" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "running");
    await s.sessions.send(session.id, { text: "B" });
    await s.sessions.sendNow(session.id, { text: "NOW", clientId: "now" });
    release();
    await waitFor(() => s.sessions.queue(session.id).messages.length === 0);
    assert.deepEqual(s.harness.handles.get(session.id)!.sent.map(m => m.text), ["A", "NOW", "B"]);
    await assert.rejects(s.sessions.sendNow(session.id), /nothing queued/);
    await s.sessions.sendNow(session.id, { text: "NOW", clientId: "now" });
    assert.equal(s.harness.handles.get(session.id)!.sent.filter(m => m.text === "NOW").length, 1);
  } finally { release(); await s.sessions.close(); }
});

test("send now does not dispatch while an uncertain receipt is unresolved", async () => {
  const s = setup({ harness: { script: (_message, turn) => turn === 0 ? [{ text: "Done" }] : [{ fail: "usage limit" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.send(session.id, { text: "B" });
    await waitFor(() => s.sessions.queue(session.id).messages.some(m => m.state === "uncertain"));
    const sent = s.harness.starts.length;
    await assert.rejects(s.sessions.sendNow(session.id, { text: "Skip" }), /uncertain/);
    assert.equal(s.harness.starts.length, sent);
    assert.deepEqual(s.sessions.queue(session.id).messages.map(m => m.message.text), ["B"]);
  } finally { await s.sessions.close(); }
});

test("a completed idempotency retry succeeds even while a later turn waits", async () => {
  const s = setup();
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    const message = { text: "B", clientId: "response-lost" };
    await s.sessions.send(session.id, message);
    await waitFor(() => s.sessions.queue(session.id).messages.length === 0);
    s.sessions.patch(session.id, { state: "waiting" });
    const sent = s.harness.handles.get(session.id)!.sent.length;
    await s.sessions.send(session.id, message);
    assert.equal(s.harness.handles.get(session.id)!.sent.length, sent);
    assert.equal(s.sessions.get(session.id)!.state, "waiting");
  } finally { await s.sessions.close(); }
});

test("stopping a follow-up the agent already acted on completes it: nothing uncertain, no resurrected message", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 1 ? [{ text: "working" }, { wait: gate }, { text: "never" }] : [{ text: "Done" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.send(session.id, { text: "B" });
    await waitFor(() => s.harnessEvents.some(e => e.event.type === "entry" && e.event.entry.kind === "assistant" && e.event.entry.text === "working"));
    await s.sessions.interrupt(session.id);
    release();
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    assert.deepEqual(s.sessions.queue(session.id).messages, []);
    // A message sent after the stop goes straight through.
    await s.sessions.send(session.id, { text: "C" });
    await waitFor(() => s.harness.handles.get(session.id)!.sent.some(m => m.text === "C"));
    await waitFor(() => s.sessions.queue(session.id).messages.length === 0);
    assert.equal(s.sessions.queue(session.id).paused, false);
    assert.deepEqual(s.harness.handles.get(session.id)!.sent.map(m => m.text), ["A", "B", "C"]);
  } finally { release(); await s.sessions.close(); }
});

test("an immediate stop, before the agent acted, returns the message to the paused queue intact", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 1 ? [{ wait: gate }, { text: "never" }] : [{ text: "Done" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.send(session.id, { text: "B", attachments: [{ name: "n.txt", mediaType: "text/plain", data: "x" }] });
    await waitFor(() => s.sessions.queue(session.id).messages.some(m => m.state === "sending"));
    await s.sessions.interrupt(session.id);
    release();
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    const q = s.sessions.queue(session.id);
    assert.equal(q.paused, true);
    assert.deepEqual(q.messages.map(m => [m.message.text, m.state]), [["B", "queued"]]);
    assert.equal(q.messages[0]!.message.attachments?.length, 1);
    // Editing then resuming delivers it exactly once more; a fresh send behind it keeps order.
    s.sessions.editQueuedMessage(session.id, q.messages[0]!.id, { text: "B2" });
    await s.sessions.send(session.id, { text: "C" });
    await s.sessions.resumeQueue(session.id);
    await waitFor(() => s.sessions.queue(session.id).messages.length === 0);
    assert.deepEqual(s.harness.handles.get(session.id)!.sent.map(m => m.text), ["A", "B", "B2", "C"]);
  } finally { release(); await s.sessions.close(); }
});

test("a real failure still leaves the message uncertain", async () => {
  const s = setup({ harness: { script: (_message, turn) => turn === 0 ? [{ text: "Done" }] : [{ text: "partial" }, { fail: "boom" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.send(session.id, { text: "B" });
    await waitFor(() => s.sessions.queue(session.id).messages.some(m => m.state === "uncertain"));
  } finally { await s.sessions.close(); }
});
