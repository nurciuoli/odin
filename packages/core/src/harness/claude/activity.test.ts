import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskActivity } from "@odin/shared/harness";
import { taskEvents } from "./activity.ts";
import { historyEntries } from "./history.ts";
import { createClaudeHarness } from "./driver.ts";
import { createMapState, mapMessage } from "./map.ts";
import { foldHarnessEvents } from "@odin/shared/transcript";

test("native task runs reject late notifications and retain terminal facts before start", () => {
  const tasks = new Map<string, TaskActivity>();
  const send = (m: Record<string, unknown>) => taskEvents(tasks, { task_id: "a", run_id: "02", ...m });
  send({ subtype: "task_notification", status: "failed", summary: "Failed" });
  send({ subtype: "task_started", task_type: "local_agent", description: "Review", tool_use_id: "tool" });
  assert.equal(tasks.get("a")?.state, "failed");
  send({ subtype: "task_started", run_id: "03", task_type: "local_agent", description: "Retry" });
  assert.equal(tasks.get("a")?.state, "running");
  assert.deepEqual(send({ subtype: "task_notification", status: "completed", run_id: "02" }), []);
  assert.deepEqual(send({ subtype: "task_notification", status: "completed" , run_id: undefined }), []);
  assert.equal(tasks.get("a")?.startedAt, null);
});

test("background snapshots exclude ambient work and missing membership means unknown", () => {
  const tasks = new Map<string, TaskActivity>();
  taskEvents(tasks, { subtype: "background_tasks_changed", tasks: [{ task_id: "a", task_type: "local_bash", description: "Tests" }, { task_id: "ambient", ambient: true }] });
  assert.equal(tasks.size, 1);
  assert.equal(tasks.get("a")?.kind, "command");
  taskEvents(tasks, { subtype: "background_tasks_changed", tasks: [] });
  assert.equal(tasks.get("a")?.state, "unknown");
});

test("stored native task events keep separate resumed runs and cannot claim live execution", () => {
  const transcript = historyEntries([
    { type: "system", subtype: "task_started", task_id: "a", run_id: "01", task_type: "local_agent", description: "Review" },
    { type: "system", subtype: "task_updated", task_id: "a", run_id: "01", patch: { status: "completed", end_time: 1000 } },
    { type: "system", subtype: "task_started", task_id: "a", run_id: "02", task_type: "local_agent", description: "Review again" },
  ] as any);
  assert.deepEqual(transcript.map(e => e.kind === "task" && [e.task.runId, e.task.state, e.task.completedAt]), [["01", "completed", "1970-01-01T00:00:01.000Z"], ["02", "unknown", null]]);
});

test("child history checks native parent membership and never starts a query", async () => {
  const task = { kind: "agent", childSessionId: "child" } as TaskActivity;
  let reads = 0;
  const harness = createClaudeHarness({ sdk: {
    query: (() => { throw new Error("Must not start query"); }) as any,
    listSubagents: async () => ["child"],
    getSubagentMessages: async () => { reads++; return []; },
  } });
  assert.deepEqual(await harness.taskMessages!("parent", task, "/fixture"), { status: "available", transcript: [] });
  assert.equal((await harness.taskMessages!("parent", { ...task, childSessionId: "other" })).status, "unavailable");
  assert.equal(reads, 1);
});

test("foreground, background and nested tasks retain linkage across parent turn interruption and history replay", () => {
  const messages = [
    { type: "system", subtype: "task_started", task_id: "parent", run_id: "01", task_type: "local_agent", description: "Foreground review", tool_use_id: "spawn-parent", is_backgrounded: false },
    { type: "system", subtype: "task_started", task_id: "child", run_id: "01", task_type: "local_agent", description: "Nested review", tool_use_id: "spawn-child", parent_task_id: "parent", is_backgrounded: true },
    { type: "system", subtype: "task_started", task_id: "shell", run_id: "01", task_type: "local_bash", description: "Background tests", tool_use_id: "shell-tool", parent_task_id: "child", is_backgrounded: true },
    { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "child", run_id: "01", task_type: "local_agent", description: "Nested review", parent_task_id: "parent" }, { task_id: "shell", run_id: "01", task_type: "local_bash", description: "Background tests", parent_task_id: "child" }] },
  ];
  const state = createMapState();
  const liveEvents = messages.flatMap(m => mapMessage(state, m));
  // Interrupted parent turn is not evidence that a background child stopped.
  mapMessage(state, { type: "result", subtype: "error_during_execution", errors: ["Interrupted"], duration_ms: 0 });
  assert.equal(state.tasks.get("parent")?.state, "running");
  assert.equal(state.tasks.get("child")?.state, "running");
  assert.equal(state.tasks.get("child")?.parentToolUseId, "spawn-parent");
  assert.equal(state.tasks.get("shell")?.parentToolUseId, "spawn-child");
  const normalize = (entries: ReturnType<typeof historyEntries>) => entries.map(e => e.kind === "task" ? { ...e, task: { ...e.task, state: e.task.state === "running" ? "unknown" : e.task.state, observedAt: null } } : e);
  assert.deepEqual(normalize(foldHarnessEvents(liveEvents)), normalize(historyEntries(messages as any)));
});

test("history preserves meaningful unrelated system notices beside lifecycle entries", () => {
  const entries = historyEntries([
    { type: "system", subtype: "compact_boundary", uuid: "compact", timestamp: "2026-01-01T00:00:00Z", compact_metadata: { trigger: "manual", pre_tokens: 10 } },
    { type: "system", subtype: "task_started", task_id: "a", task_type: "local_agent", description: "Review" },
  ] as any);
  assert.equal(entries[0].kind, "system");
  if (entries[0].kind === "system") assert.match(entries[0].text, /Conversation compacted/);
  assert.equal(entries[1].kind, "task");
});
