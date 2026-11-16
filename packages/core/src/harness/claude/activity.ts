import type { TaskActivity, HarnessEvent } from "@odin/shared/harness";

type Wire = Record<string, any>;
const str = (v: unknown): string | null => typeof v === "string" ? v : null;
const date = (v: unknown): string | null => typeof v === "number" && Number.isFinite(v) ? new Date(v).toISOString() : null;
const terminal = (s: string) => ["completed", "failed", "stopped"].includes(s);
const backgroundSets = new WeakMap<Map<string, TaskActivity>, Set<string>>();

/** Native task facts only. Observation time is never promoted to a start/end time. */
export function taskEvents(tasks: Map<string, TaskActivity>, m: Wire, history = false): HarnessEvent[] {
  if (m.subtype === "background_tasks_changed") {
    const previousSet = backgroundSets.get(tasks) ?? new Set<string>();
    const live = new Set<string>();
    const out: HarnessEvent[] = [];
    for (const t of m.tasks ?? []) {
      if (t.ambient) continue;
      live.add(t.task_id);
      out.push(...taskEvents(tasks, { ...t, subtype: "task_started", is_backgrounded: true }, history));
    }
    for (const [id, t] of tasks) if (previousSet.has(id) && !live.has(id) && t.state === "running") {
      const task = { ...t, state: "unknown" as const };
      tasks.set(id, task);
      out.push({ type: "task", task });
    }
    backgroundSets.set(tasks, live);
    return out;
  }
  if (!str(m.task_id) || m.ambient || m.skip_transcript) return [];
  const previous = tasks.get(m.task_id);
  const runId = str(m.run_id);
  if (previous?.runId && (!runId || runId < previous.runId)) return [];
  const same = previous && previous.runId === runId ? previous : undefined;
  const patch = m.patch ?? {};
  const taskType = m.task_type;
  if (taskType && taskType !== "local_agent" && taskType !== "local_bash") return [];
  let state: TaskActivity["state"] = same?.state ?? "unknown";
  const status = patch.status ?? m.status;
  if (status === "completed" || status === "failed") state = status;
  else if (status === "killed" || status === "stopped") state = "stopped";
  else if (status === "paused") state = "unknown";
  else if (m.subtype === "task_started" || status === "running" || status === "pending") state = history ? "unknown" : "running";
  // Completion arriving before start remains authoritative.
  if (same && terminal(same.state) && !terminal(state)) state = same.state;
  const kind = taskType === "local_bash" ? "command" : same?.kind ?? "agent";
  const task: TaskActivity = {
    taskId: m.task_id, runId, kind,
    label: str(patch.description) ?? str(m.description) ?? same?.label ?? "Background task",
    state, toolUseId: str(m.tool_use_id) ?? same?.toolUseId ?? null,
    parentToolUseId: str(m.parent_tool_use_id) ?? tasks.get(m.parent_task_id)?.toolUseId ?? same?.parentToolUseId ?? null,
    childSessionId: kind === "agent" ? str(m.agent_id) ?? same?.childSessionId ?? m.task_id : null,
    startedAt: same?.startedAt ?? null,
    completedAt: date(patch.end_time) ?? same?.completedAt ?? (terminal(state) ? str(m.timestamp) : null),
    observedAt: history ? null : new Date().toISOString(),
    ...(same?.summary ? { summary: same.summary } : {}),
    ...(str(m.summary) ? { summary: m.summary } : {}),
  };
  tasks.set(task.taskId, task);
  return [{ type: "task", task }];
}
