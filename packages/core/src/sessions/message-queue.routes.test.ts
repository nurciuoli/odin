import { test } from "node:test";
import assert from "node:assert/strict";
import type { MessageQueue, Session } from "@odin/shared/api";
import { PROJECT, serve, setup, waitFor } from "./test-setup.ts";

test("HTTP queue keeps attachments visible across pause, edits and explicit resume", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 0 ? [{ wait: gate }] : [{ text: "Done" }] } });
  const app = await serve(s);
  try {
    const started = await app.post("/api/sessions", { project: PROJECT, prompt: { text: "A" } });
    const session = await started.json() as Session;
    const base = `/api/sessions/${session.id}`;
    await waitFor(() => s.harness.handles.get(session.id)?.sent.length === 1);
    const message = { text: "B", clientId: "http-retry-b", attachments: [{ name: "notes.txt", mediaType: "text/plain", data: "hello" }] };
    assert.equal((await app.post(`${base}/messages`, message)).status, 200);
    assert.equal((await app.post(`${base}/messages`, message)).status, 200);
    const queue = await (await app.api(`${base}/queue`)).json() as MessageQueue;
    assert.equal(queue.messages.length, 1);
    assert.deepEqual(queue.messages[0]!.message.attachments, message.attachments);
    assert.equal((await app.post(`${base}/messages`, { ...message, text: "Different" })).status, 409);
    const id = queue.messages[0]!.id;
    assert.equal((await app.post(`${base}/interrupt`)).status, 204);
    release();
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    const paused = await (await app.api(`${base}/queue`)).json() as MessageQueue;
    assert.equal(paused.paused, true);
    assert.equal(paused.messages.length, 1);
    assert.equal(s.harness.handles.get(session.id)!.sent.length, 1);
    const edited = await app.api(`${base}/queue/${id}`, { method: "PATCH", body: JSON.stringify({ ...message, text: "B edited" }) });
    assert.equal(edited.status, 200);
    assert.equal((await app.post(`${base}/queue/resume`)).status, 200);
    await waitFor(() => s.harness.handles.get(session.id)!.sent.length === 2);
    assert.equal(s.harness.handles.get(session.id)!.sent[1]!.text, "B edited");
    assert.deepEqual(s.harness.handles.get(session.id)!.sent[1]!.attachments, message.attachments);
    await waitFor(async () => ((await (await app.api(`${base}/queue`)).json()) as MessageQueue).messages.length === 0);
    assert.ok(s.deps.events.some(event => event.type === "session.queue" && event.sessionId === session.id));
  } finally { release(); await app.close(); }
});

test("HTTP send-now interrupts the turn and returns the queue", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 0 ? [{ wait: gate }] : [{ text: "Done" }] } });
  const app = await serve(s);
  try {
    const session = await (await app.post("/api/sessions", { project: PROJECT, prompt: { text: "A" } })).json() as Session;
    const base = `/api/sessions/${session.id}`;
    await waitFor(() => s.sessions.get(session.id)?.state === "running");
    assert.equal((await app.post(`${base}/messages`, { text: "B" })).status, 200);
    const sent = await app.post(`${base}/queue/send-now`, { text: "NOW" });
    assert.equal(sent.status, 200);
    release();
    await waitFor(() => s.harness.handles.get(session.id)!.sent.some(m => m.text === "NOW"));
    await waitFor(async () => ((await (await app.api(`${base}/queue`)).json()) as MessageQueue).messages.length === 0);
    assert.deepEqual(s.harness.handles.get(session.id)!.sent.map(m => m.text), ["A", "NOW", "B"]);
    assert.equal((await app.post(`${base}/queue/send-now`)).status, 409);
    assert.equal((await app.post("/api/sessions/missing/queue/send-now")).status, 404);
  } finally { release(); await app.close(); }
});

test("HTTP queue cancellation persists and rejects unknown sessions", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: () => [{ wait: gate }] } });
  const app = await serve(s);
  try {
    const session = await (await app.post("/api/sessions", { project: PROJECT, prompt: { text: "A" } })).json() as Session;
    const base = `/api/sessions/${session.id}`;
    await app.post(`${base}/messages`, { text: "Cancel me", clientId: "cancel-me" });
    const queue = await (await app.api(`${base}/queue`)).json() as MessageQueue;
    const id = queue.messages[0]!.id;
    assert.equal((await app.api(`${base}/queue/${id}`, { method: "DELETE" })).status, 200);
    const detail = await (await app.api(base)).json();
    assert.deepEqual(detail.messageQueue.messages, []);
    assert.equal((await app.api("/api/sessions/missing/queue")).status, 404);
    assert.equal((await app.post("/api/sessions/missing/queue/resume")).status, 404);
    assert.equal((await app.api(`${base}/queue/missing`, { method: "PATCH", body: JSON.stringify({ text: "x" }) })).status, 404);
  } finally { release(); await app.close(); }
});

test("send during the turn-end to idle gap stays in the service outbox", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: (_message, turn) => turn === 0
    ? [{ emit: { type: "turn.end", durationMs: 1, ok: true, error: null } }, { wait: gate }]
    : [{ text: "Done" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.harnessEvents.some(({ event }) => event.type === "turn.end"));
    assert.equal(s.sessions.get(session.id)!.state, "running");
    await s.sessions.send(session.id, { text: "B" });
    assert.equal(s.harness.handles.get(session.id)!.sent.length, 1, "driver must not receive B before idle");
    assert.equal(s.sessions.queue(session.id).messages[0]!.state, "queued");
    release();
    await waitFor(() => s.harness.handles.get(session.id)!.sent.length === 2);
    await waitFor(() => s.sessions.queue(session.id).messages.length === 0);
  } finally { release(); await s.sessions.close(); }
});

test("native transport loss retains the dispatched message as uncertain without replaying later work", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const s = setup({ harness: { script: message => message.text === "B"
    ? [{ wait: gate }, { fail: "transport lost" }]
    : [{ text: "Done" }] } });
  try {
    const session = await s.sessions.start({ project: PROJECT, prompt: { text: "A" } });
    await waitFor(() => s.sessions.get(session.id)?.state === "idle");
    await s.sessions.send(session.id, { text: "B", clientId: "transport-b" });
    await s.sessions.send(session.id, { text: "C", clientId: "transport-c" });
    release();
    await waitFor(() => s.sessions.get(session.id)?.state === "failed");
    const queue = s.sessions.queue(session.id);
    assert.equal(queue.paused, true);
    assert.deepEqual(queue.messages.map(message => [message.message.text, message.state]), [["B", "uncertain"], ["C", "queued"]]);
    await assert.rejects(s.sessions.resumeQueue(session.id), /uncertain/);
    s.sessions.cancelQueuedMessage(session.id, queue.messages[0]!.id);
    await s.sessions.resumeQueue(session.id);
    await waitFor(() => s.sessions.queue(session.id).messages.length === 0);
    const userText = s.harness.stored(session.id)!.filter(entry => entry.kind === "user").map(entry => entry.text);
    assert.deepEqual(userText, ["A", "B", "C"], "B must not be replayed after dismissing its uncertain receipt");
  } finally { release(); await s.sessions.close(); }
});
