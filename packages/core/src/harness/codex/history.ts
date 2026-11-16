// Read-only compatibility for runtimes that cannot read an unloaded thread through app-server.
// The native rollout remains the source of truth; no turn is started or resumed.
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEntry } from "@odin/shared/harness";
import { foldHarnessEvents } from "@odin/shared/transcript";
import { itemEntry } from "./map.ts";
import { itemTasks, taskEntries } from "./activity.ts";
import type { TaskActivity } from "@odin/shared/harness";
import type { Wire } from "./transport.ts";

const MAX_BYTES = 8 * 1024 * 1024;

export function rolloutItem(item: Wire): Wire {
  const type = typeof item.type === "string" ? item.type[0].toLowerCase() + item.type.slice(1) : "";
  const mapped: Wire = { ...item, type };
  for (const [snake, camel] of [["agent_thread_id", "agentThreadId"], ["agent_path", "agentPath"], ["aggregated_output", "aggregatedOutput"], ["exit_code", "exitCode"], ["process_id", "processId"]]) {
    if (item[snake] !== undefined) mapped[camel] = item[snake];
  }
  if (type === "agentMessage" && mapped.text === undefined) mapped.text = (item.content ?? []).map((c: Wire) => c.text ?? "").join("\n");
  if (type === "fileChange" && item.changes && !Array.isArray(item.changes)) mapped.changes = Object.entries(item.changes).map(([path, change]) => ({ path, ...(change as Wire) }));
  if (type === "userMessage") mapped.content = (item.content ?? []).map((c: Wire) => ({ ...c, type: c.type === "input_text" ? "text" : c.type }));
  return mapped;
}

export async function readNativeHistory(sessionId: string, root: string): Promise<{ transcript: TranscriptEntry[]; parentId: string | null } | null> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionId)) return null;
  let visited = 0;
  const find = async (dir: string, depth: number): Promise<string | null> => {
    if (depth > 4 || ++visited > 30_000) return null;
    let children;
    try { children = await readdir(dir, { withFileTypes: true }); } catch { return null; }
    for (const entry of children) {
      if (++visited > 30_000) return null;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const result = await find(join(dir, entry.name), depth + 1);
        if (result) return result;
      } else if (entry.isFile() && entry.name.endsWith(`-${sessionId}.jsonl`)) return join(dir, entry.name);
    }
    return null;
  };
  try {
    const file = await find(root, 0);
    if (!file) return null;
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) return null;
    const handle = await open(file, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_BYTES) return null;
      text = buffer.toString("utf8", 0, bytesRead);
    } finally { await handle.close(); }
    const rows: Wire[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* The active writer may have an incomplete final line. */ }
    }
    const meta = rows.find(row => row.type === "session_meta")?.payload;
    if (meta?.id !== sessionId) return null;
    const entries: TranscriptEntry[] = [];
    const agents = new Map<string, TaskActivity>();
    for (const row of rows) {
      if (row.type !== "event_msg" || row.payload?.type !== "item_completed" || !row.payload.item) continue;
      const item: Wire = { ...rolloutItem(row.payload.item), startedAtMs: row.payload.started_at_ms, completedAtMs: row.payload.completed_at_ms };
      let entry: TranscriptEntry | null = null;
      try { entry = itemEntry(item, null); } catch {
        entry = { kind: "system", id: String(item.id ?? `unsupported:${entries.length}`), level: "warning", text: "Native history item is unavailable", at: null, parentToolUseId: null };
      }
      if (entry) entries.push(entry);
      entries.push(...taskEntries(itemTasks(item, true, agents)));
    }
    if (!entries.length && rows.some(row => row.type === "response_item")) return null;
    return { transcript: foldHarnessEvents(entries.map(entry => ({ type: "entry", entry }))), parentId: meta.parent_thread_id ?? meta.source?.subagent?.thread_spawn?.parent_thread_id ?? null };
  } catch { return null; }
}
