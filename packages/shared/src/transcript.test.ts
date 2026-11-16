import { test } from "node:test";
import assert from "node:assert/strict";
import type { HarnessEvent, TaskActivity } from "./harness.ts";
import { TOOL_RESULT_MAX_CHARS } from "./harness.ts";

test("offset deltas reconcile overlapping REST partials and reject gaps", () => {
  const delta = (text: string, offset: number): HarnessEvent => ({ type: "delta", entryId: "a", kind: "assistant", text, offset, parentToolUseId: null });
  const partial = applyHarnessEvent([], delta("hello", 0));
  assert.equal(applyHarnessEvent(partial, delta("hello", 0)), partial);
  const overlap = applyHarnessEvent(partial, delta("lo world", 3));
  assert.equal((overlap[0] as { text: string }).text, "hello world");
  assert.equal(applyHarnessEvent(overlap, delta("gap", 99)), overlap);
  assert.deepEqual(applyHarnessEvent([], delta("gap", 5)), []);
});
import { applyHarnessEvent, foldHarnessEvents, toolResult, reconcileTaskHistory } from "./transcript.ts";

const taskFixture = (patch: Partial<TaskActivity> = {}): TaskActivity => ({
  taskId: "native", runId: "run-1", kind: "agent", label: "Review code", state: "running",
  toolUseId: "spawn", parentToolUseId: null, childSessionId: "child", startedAt: null,
  completedAt: null, observedAt: null, ...patch,
});

test("task completion before start and duplicate notifications reconcile into one run", () => {
  const finished = taskFixture({ state: "completed", completedAt: "2026-11-12T12:01:00Z", summary: "Reviewed" });
  let entries = foldHarnessEvents([{ type: "task", task: finished }, { type: "task", task: finished },
    { type: "task", task: taskFixture({ startedAt: "2026-11-12T12:00:00Z" }) }]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind === "task" && entries[0]!.task.state, "completed");
  assert.equal(entries[0]!.kind === "task" && entries[0]!.task.startedAt, "2026-11-12T12:00:00Z");
  entries = applyHarnessEvent(entries, { type: "task", task: taskFixture({ runId: "run-2" }) });
  assert.equal(entries.length, 2);
  assert.deepEqual(reconcileTaskHistory(entries).map((e) => e.kind === "task" && e.task.state), ["completed", "unknown"]);
});

test("task snapshots reject stale states, bound output and replace final snapshots without appending", () => {
  const entries = foldHarnessEvents([
    { type: "task", task: taskFixture({ state: "failed", observedAt: "2026-11-12T12:02:00Z", output: toolResult(false, "final") }) },
    { type: "task", task: taskFixture({ state: "completed", observedAt: "2026-11-12T12:01:00Z", output: toolResult(true, "stale") }) },
  ]);
  assert.equal(entries[0]!.kind === "task" && entries[0]!.task.state, "failed");
  assert.equal(entries[0]!.kind === "task" && entries[0]!.task.output?.text, "final");
  const long = foldHarnessEvents([{ type: "task", task: taskFixture({ kind: "command", output: { ok: true, text: "x".repeat(TOOL_RESULT_MAX_CHARS + 1), truncated: false } }) }]);
  assert.equal(long[0]!.kind === "task" && long[0]!.task.output?.text.length, TOOL_RESULT_MAX_CHARS);
  assert.equal(long[0]!.kind === "task" && long[0]!.task.output?.truncated, true);
});

test("deltas build an entry; the whole entry replaces it", () => {
  const events: HarnessEvent[] = [
    { type: "delta", entryId: "m1", kind: "assistant", text: "Hel", parentToolUseId: null },
    { type: "delta", entryId: "m1", kind: "assistant", text: "lo", parentToolUseId: null },
  ];
  const partial = foldHarnessEvents(events);
  assert.equal(partial.length, 1);
  assert.equal(partial[0]!.kind === "assistant" && partial[0]!.text, "Hello");
  const done = applyHarnessEvent(partial, {
    type: "entry",
    entry: { kind: "assistant", id: "m1", text: "Hello.", model: "claude-x", at: "2026-11-11T00:00:00Z", parentToolUseId: null },
  });
  assert.equal(done.length, 1);
  assert.equal(done[0]!.kind === "assistant" && done[0]!.text, "Hello.");
  assert.notEqual(done, partial);
});

test("tool results attach to their call and survive a re-sent call entry", () => {
  const call = { kind: "tool" as const, id: "t1", name: "Bash", input: { command: "ls" }, at: null, parentToolUseId: null };
  let t = foldHarnessEvents([{ type: "entry", entry: call }, { type: "tool.result", toolUseId: "t1", result: toolResult(true, "a.txt") }]);
  assert.deepEqual(t[0]!.kind === "tool" && t[0]!.result, { ok: true, text: "a.txt", truncated: false });
  t = applyHarnessEvent(t, { type: "entry", entry: call });
  assert.equal(t[0]!.kind === "tool" && t[0]!.result?.text, "a.txt");
});

test("unrelated events return the same array; unknown tool results are ignored", () => {
  const t = foldHarnessEvents([{ type: "entry", entry: { kind: "user", id: "u1", text: "hi", at: null, parentToolUseId: null } }]);
  assert.equal(applyHarnessEvent(t, { type: "state", state: "running" }), t);
  assert.equal(applyHarnessEvent(t, { type: "tool.result", toolUseId: "nope", result: toolResult(true, "") }), t);
});

test("toolResult truncates long text", () => {
  const r = toolResult(false, "x".repeat(TOOL_RESULT_MAX_CHARS + 5));
  assert.equal(r.text.length, TOOL_RESULT_MAX_CHARS);
  assert.equal(r.truncated, true);
  assert.equal(r.ok, false);
});
