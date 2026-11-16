// Folding live harness events into a transcript. Core uses it to keep a live session's tail; the web uses it to render
// the Session screen from `SessionDetail.transcript` plus `session.event` SSE frames. Pure: returns a new array.
import type { HarnessEvent, ToolResult, TranscriptEntry } from "./harness.ts";
import { TOOL_RESULT_MAX_CHARS, taskKey } from "./harness.ts";
import type { TaskActivity } from "./harness.ts";

function mergeTask(current: TaskActivity, incoming: TaskActivity): TaskActivity {
  const terminal = (state: TaskActivity["state"]) => state === "completed" || state === "failed" || state === "stopped";
  const stale = current.observedAt !== null && incoming.observedAt !== null && incoming.observedAt < current.observedAt;
  const keepState = terminal(current.state) && !terminal(incoming.state) || stale;
  const merged = { ...current, ...incoming, state: keepState ? current.state : incoming.state };
  for (const key of ["toolUseId", "parentToolUseId", "childSessionId", "startedAt", "completedAt", "observedAt"] as const) {
    if (incoming[key] === null || stale) merged[key] = current[key] ?? incoming[key];
  }
  if (stale) {
    merged.summary = current.summary ?? incoming.summary;
    merged.output = current.output ?? incoming.output;
  }
  if (merged.output) merged.output = { ...toolResult(merged.output.ok, merged.output.text, merged.output.status), truncated: merged.output.truncated || merged.output.text.length > TOOL_RESULT_MAX_CHARS };
  return merged;
}

/** Stored history alone cannot establish process-local liveness. */
export function reconcileTaskHistory(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.map((entry) => entry.kind === "task" && entry.task.state === "running"
    ? { ...entry, task: { ...entry.task, state: "unknown" } }
    : entry);
}

/** Applies one event. Events that don't change the transcript (state, usage, …) return the same array. */
export function applyHarnessEvent(entries: TranscriptEntry[], event: HarnessEvent): TranscriptEntry[] {
  switch (event.type) {
    case "task": {
      const id = taskKey(event.task);
      const i = entries.findIndex((entry) => entry.kind === "task" && taskKey(entry.task) === id);
      const current = i < 0 ? null : entries[i];
      const task = current?.kind === "task" ? mergeTask(current.task, event.task) : mergeTask(event.task, event.task);
      const entry: TranscriptEntry = { kind: "task", id, task, at: task.startedAt ?? task.completedAt, parentToolUseId: task.parentToolUseId };
      if (i < 0) return [...entries, entry];
      const next = entries.slice();
      next[i] = entry;
      return next;
    }
    case "delta": {
      const i = entries.findIndex((e) => e.id === event.entryId);
      if (i < 0) {
        if (event.offset !== undefined && event.offset !== 0) return entries;
        const entry: TranscriptEntry =
          event.kind === "assistant"
            ? { kind: "assistant", id: event.entryId, text: event.text, model: null, at: null, parentToolUseId: event.parentToolUseId }
            : { kind: "thinking", id: event.entryId, text: event.text, at: null, parentToolUseId: event.parentToolUseId };
        return [...entries, entry];
      }
      const cur = entries[i]!;
      if (cur.kind !== "assistant" && cur.kind !== "thinking") return entries;
      if (event.offset !== undefined && (!Number.isInteger(event.offset) || event.offset < 0 || event.offset > cur.text.length)) return entries;
      const text = event.offset === undefined ? event.text : event.text.slice(cur.text.length - event.offset);
      if (!text) return entries;
      const next = entries.slice();
      next[i] = { ...cur, text: cur.text + text };
      return next;
    }
    case "entry": {
      if (event.entry.kind === "task") return applyHarnessEvent(entries, { type: "task", task: event.entry.task });
      const i = entries.findIndex((e) => e.id === event.entry.id);
      if (i < 0) return [...entries, event.entry];
      const next = entries.slice();
      const cur = entries[i]!;
      // A re-sent tool entry keeps a result that already arrived.
      next[i] = cur.kind === "tool" && event.entry.kind === "tool" && !event.entry.result && cur.result
        ? { ...event.entry, result: cur.result }
        : event.entry;
      return next;
    }
    case "tool.result": {
      const i = entries.findIndex((e) => e.kind === "tool" && e.id === event.toolUseId);
      if (i < 0) return entries;
      const next = entries.slice();
      next[i] = { ...(entries[i] as Extract<TranscriptEntry, { kind: "tool" }>), result: event.result };
      return next;
    }
    default:
      return entries;
  }
}

/** Folds a list of events (e.g. a test script) from an empty or given transcript. */
export function foldHarnessEvents(events: HarnessEvent[], start: TranscriptEntry[] = []): TranscriptEntry[] {
  return events.reduce(applyHarnessEvent, start);
}

/** A display-safe tool result: text cut to TOOL_RESULT_MAX_CHARS. */
export function toolResult(ok: boolean, text: string, status?: ToolResult["status"]): ToolResult {
  const truncated = text.length > TOOL_RESULT_MAX_CHARS;
  return { ok, text: truncated ? text.slice(0, TOOL_RESULT_MAX_CHARS) : text, truncated, ...(status ? { status } : {}) };
}
