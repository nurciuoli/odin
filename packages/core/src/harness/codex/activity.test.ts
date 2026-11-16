import { test } from "node:test";
import assert from "node:assert/strict";
import type { TaskActivity } from "@odin/shared/harness";
import { TOOL_RESULT_MAX_CHARS } from "@odin/shared/harness";
import { itemTasks } from "./activity.ts";
import { itemEntry } from "./map.ts";
import { foldHarnessEvents } from "@odin/shared/transcript";

test("collaboration completion never completes a running child; resume has a separate native operation identity", () => {
  const agents = new Map<string, TaskActivity>();
  const spawn = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], prompt: "Review", agentsStates: { child: { status: "running" } } };
  const [first] = itemTasks(spawn, false, agents);
  assert.equal(first.state, "running");
  assert.equal(first.runId, "spawn");
  itemTasks({ ...spawn, id: "wait", tool: "wait", status: "inProgress" }, false, agents);
  const [done] = itemTasks({ ...spawn, id: "wait", tool: "wait", agentsStates: { child: { status: "completed", message: "Done" } } }, false, agents);
  assert.equal(done.runId, "spawn");
  assert.equal(done.state, "completed");
  const [resumed] = itemTasks({ ...spawn, id: "resume", tool: "resumeAgent" }, false, agents);
  assert.equal(resumed.runId, "resume");
  assert.equal(resumed.state, "running");
  assert.equal(itemTasks(spawn, true)[0].state, "unknown");
  assert.equal(itemTasks({ ...spawn, agentsStates: {} })[0].state, "unknown");
});

test("late wait completion belongs to the run observed when waiting began", () => {
  const agents = new Map<string, TaskActivity>();
  const item = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } };
  itemTasks(item, false, agents);
  itemTasks({ ...item, id: "wait-old", tool: "wait", status: "inProgress" }, false, agents);
  itemTasks({ ...item, id: "resume", tool: "resumeAgent" }, false, agents);
  const [late] = itemTasks({ ...item, id: "wait-old", tool: "wait", agentsStates: { child: { status: "completed" } } }, false, agents);
  assert.equal(late.runId, "spawn");
  assert.equal(agents.get("child")?.runId, "resume");
  assert.equal(agents.get("child")?.state, "running");
  const [unmatched] = itemTasks({ ...item, id: "unknown-wait", tool: "wait", agentsStates: { child: { status: "completed" } } }, false, agents);
  assert.equal(unmatched.state, "unknown");
});

test("native subAgentActivity updates one card per run and suppresses generic transcript lines", () => {
  const agents = new Map<string, TaskActivity>();
  const base = { type: "subAgentActivity", agentThreadId: "child", agentPath: "/root/reviewer", model: "fixture", reasoningEffort: "high" };
  const items = [
    { ...base, id: "start", kind: "started" },
    { ...base, id: "interaction", kind: "interacted" },
    { ...base, id: "complete", kind: "completed" },
    { ...base, id: "new-interaction", kind: "interacted" },
    { ...base, id: "new-complete", kind: "completed" },
  ];
  const tasks = items.flatMap(item => itemTasks(item, false, agents));
  const entries = foldHarnessEvents(tasks.map(task => ({ type: "task", task })));
  assert.equal(entries.length, 2);
  assert.equal(tasks[0].state, "running");
  assert.equal(tasks[3].state, "unknown");
  assert.equal(tasks[3].runId, "new-interaction");
  assert.ok(entries.every(e => e.kind === "task" && e.task.state === "completed" && e.task.childSessionId === "child"));
  assert.ok(items.every(item => itemEntry(item, null) === null));
  const historical = new Map<string, TaskActivity>();
  assert.equal(itemTasks(items[0], true, historical)[0].state, "unknown");
});

test("native activity and a legacy spawn correlate the same live child run", () => {
  const agents = new Map<string, TaskActivity>();
  const [spawn] = itemTasks({ type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", receiverThreadIds: ["child"], agentsStates: { child: { status: "running" } } }, false, agents);
  const [started] = itemTasks({ type: "subAgentActivity", id: "native-start", kind: "started", agentThreadId: "child", agentPath: "/root/reviewer" }, false, agents);
  assert.equal(started.runId, spawn.runId);
  assert.equal(started.toolUseId, "spawn");
});

test("command lifecycle uses native timestamps and bounds final output without appending", () => {
  const [task] = itemTasks({ type: "commandExecution", id: "command", command: "tests", status: "completed", exitCode: 1, startedAtMs: 1000, completedAtMs: 2000, aggregatedOutput: "x".repeat(TOOL_RESULT_MAX_CHARS + 1) });
  assert.equal(task.state, "failed");
  assert.equal(task.startedAt, "1970-01-01T00:00:01.000Z");
  assert.equal(task.completedAt, "1970-01-01T00:00:02.000Z");
  assert.equal(task.output?.text.length, TOOL_RESULT_MAX_CHARS);
  assert.equal(task.output?.truncated, true);
  assert.equal(itemTasks({ type: "commandExecution", id: "c", status: "inProgress" }, true)[0].state, "unknown");
});
