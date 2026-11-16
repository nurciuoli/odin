import { test } from "node:test";
import assert from "node:assert/strict";
import { taskKey, type TaskActivity, type TranscriptEntry } from "@odin/shared/harness";
import { PROJECT, setup, serve, waitFor } from "./test-setup.ts";

const task: TaskActivity = {
  taskId: "worker", runId: "run-1", kind: "agent", label: "Review changes", state: "running",
  toolUseId: "spawn", parentToolUseId: null, childSessionId: "child", startedAt: null,
  completedAt: null, observedAt: "2026-11-12T00:00:00Z",
};

test("task history route authorizes parent membership and never starts a turn", async () => {
  const s = setup({ harness: { script: () => [{ emit: { type: "task", task } }] } });
  const app = await serve(s);
  try {
    const child: TranscriptEntry = { kind: "assistant", id: "reply", text: "Review complete", model: null, at: null, parentToolUseId: null };
    s.harness.seed({ sessionId: "child", cwd: s.projectPath }, [child]);
    const parent = await s.sessions.start({ project: PROJECT, prompt: { text: "Delegate" } });
    await waitFor(() => s.sessions.get(parent.id)?.state === "idle");
    const starts = s.harness.starts.length;
    const detail = await s.sessions.detail(parent.id);
    assert.equal(detail?.transcript.find(e => e.kind === "task")?.task.state, "running");
    const path = `/api/sessions/${parent.id}/tasks/${encodeURIComponent(taskKey(task))}`;
    const res = await app.api(path);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "available", transcript: [child] });
    assert.equal((await app.api(`/api/sessions/${parent.id}/tasks/child`)).status, 404);
    assert.equal((await app.api(`/api/sessions/missing/tasks/${encodeURIComponent(taskKey(task))}`)).status, 404);
    assert.equal(s.harness.starts.length, starts);
    await s.sessions.end(parent.id);
    const stored = await s.sessions.detail(parent.id);
    assert.equal(stored?.transcript.find(e => e.kind === "task")?.task.state, "unknown");
  } finally { await app.close(); }
});

test("unsupported and failed child reads return honest unavailable results", async () => {
  const s = setup({ harness: { script: () => [{ emit: { type: "task", task } }] } });
  try {
    const parent = await s.sessions.start({ project: PROJECT, prompt: { text: "Delegate" } });
    await waitFor(() => s.sessions.get(parent.id)?.state === "idle");
    s.harness.taskMessages = undefined;
    assert.equal((await s.sessions.taskMessages(parent.id, taskKey(task))).status, "unavailable");
    s.harness.taskMessages = async () => { throw new Error("private runtime details"); };
    const result = await s.sessions.taskMessages(parent.id, taskKey(task));
    assert.equal(result.status, "unavailable");
    assert.ok(!JSON.stringify(result).includes("private runtime details"));
  } finally { await s.sessions.close(); }
});
