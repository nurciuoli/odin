import type { TaskActivity, TranscriptEntry } from "@odin/shared/harness";
import { taskKey } from "@odin/shared/harness";
import { toolResult } from "@odin/shared/transcript";
import type { Wire } from "./transport.ts";

const iso = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null;
const operationRuns = new WeakMap<Map<string, TaskActivity>, Map<string, Map<string, string | null>>>();
/** A collaboration operation's completion is independent of the receiving agent's state. */
export function itemTasks(item: Wire, history = false, agents = new Map<string, TaskActivity>()): TaskActivity[] {
  const base = { runId: null, parentToolUseId: null, startedAt: null, completedAt: null, observedAt: history ? null : new Date().toISOString() };
  if (item.type === "subAgentActivity" || item.type === "SubAgentActivity") {
    const childId = item.agentThreadId ?? item.agent_thread_id;
    if (typeof childId !== "string" || typeof item.id !== "string") return [];
    const previous = agents.get(childId);
    const terminal = previous && ["completed", "failed", "stopped"].includes(previous.state);
    let operations = operationRuns.get(agents);
    if (!operations) { operations = new Map(); operationRuns.set(agents, operations); }
    const known = operations.get(item.id)?.get(childId);
    const correlatesSpawn = item.kind === "started" && previous?.runId && previous.toolUseId !== null && !terminal;
    const opensRun = item.kind === "started" && !correlatesSpawn || item.kind === "interacted" && terminal;
    const runId = known !== undefined ? known : opensRun ? item.id : previous?.runId ?? null;
    operations.set(item.id, new Map([[childId, runId]]));
    const sameRun = previous?.runId === runId;
    const state: TaskActivity["state"] = item.kind === "completed" ? "completed" : item.kind === "interrupted" ? "stopped" : item.kind === "started" ? history ? "unknown" : "running" : sameRun && previous ? previous.state : "unknown";
    const task: TaskActivity = {
      ...base, taskId: childId, runId, kind: "agent", label: item.agentPath ?? item.agent_path ?? previous?.label ?? "Agent",
      state, toolUseId: sameRun ? previous?.toolUseId ?? null : null, childSessionId: childId,
      startedAt: sameRun ? previous?.startedAt ?? null : item.kind === "started" ? iso(item.startedAtMs) : null,
      completedAt: state === "completed" || state === "stopped" ? iso(item.completedAtMs) : null,
    };
    if (known === undefined || sameRun) agents.set(childId, task);
    return [task];
  }
  if (item.type === "collabAgentToolCall") {
    let operations = operationRuns.get(agents);
    if (!operations) { operations = new Map(); operationRuns.set(agents, operations); }
    let runs = operations.get(item.id);
    const seenOperation = runs !== undefined;
    if (!runs) { runs = new Map(); operations.set(item.id, runs); }
    return (item.receiverThreadIds ?? []).map((id: string) => {
      const native = item.agentsStates?.[id];
      const previous = agents.get(id);
      const opensRun = ["spawnAgent", "resumeAgent", "sendInput", "followupTask"].includes(item.tool);
      const runId = opensRun ? item.id : runs.has(id) ? runs.get(id)! : previous?.runId ?? null;
      runs.set(id, runId);
      const status = native?.status;
      const uncertain = !history && !opensRun && !seenOperation && item.status !== "inProgress";
      const state: TaskActivity["state"] = uncertain ? "unknown" : status === "completed" ? "completed" : status === "errored" ? "failed" : ["interrupted", "shutdown"].includes(status) ? "stopped" : !history && ["running", "pendingInit"].includes(status) ? "running" : "unknown";
      const task: TaskActivity = { ...base, runId, taskId: id, kind: "agent", label: item.prompt || previous?.label || "Agent", state, toolUseId: opensRun ? item.id : previous?.toolUseId ?? item.id, childSessionId: id, ...(native?.message ? { summary: native.message } : {}) };
      if (!previous || runId === previous.runId || opensRun && !seenOperation) agents.set(id, task);
      return task;
    });
  }
  if (item.type !== "commandExecution") return [];
  const state: TaskActivity["state"] = item.status === "completed" ? (item.exitCode != null && item.exitCode !== 0 ? "failed" : "completed") : item.status === "failed" ? "failed" : item.status === "declined" ? "stopped" : history ? "unknown" : "running";
  return [{ ...base, taskId: item.id, kind: "command", label: item.command || "Command", state, toolUseId: item.id, childSessionId: null, startedAt: iso(item.startedAtMs), completedAt: iso(item.completedAtMs), output: toolResult(state !== "failed", item.aggregatedOutput ?? "") }];
}

export function taskEntries(tasks: TaskActivity[]): TranscriptEntry[] {
  return tasks.map(task => ({ kind: "task", id: taskKey(task), task, at: task.startedAt ?? task.completedAt, parentToolUseId: task.parentToolUseId }));
}
