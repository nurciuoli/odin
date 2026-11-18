// Stored conversation (getSessionMessages) → transcript entries, with the same entry rules as the live mapping
// (map.ts): assistant blocks get `<message.id>:<index>` ids, tool_use blocks their own id, tool results attached to
// their call. User messages the driver sent with attachments (input.ts) are read back into `attachments`. Background
// task notifications the CLI injected as user text become normalized task entries, as they do live.
import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type { TranscriptEntry } from "@odin/shared/harness";
import { taskKey, type TaskActivity } from "@odin/shared/harness";
import { taskEvents } from "./activity.ts";
import { parseLocalCommand, type LocalCommandParts } from "./localcommand.ts";
import { injectedMessage, type Injected } from "./injected.ts";
import { assistantEntries, createMapState, injectedEntry, injectedId, isInterruptMessage, localOutputEntries, mapMessage, parseTaskNotifications, stripSystemReminders, taskNoticeEntry, taskNoticeId, toToolResult, type TaskNotice } from "./map.ts";

type Loose = Record<string, any>;

const IMAGE_TAG = /^<attachment name="([^"]*)" media-type="([^"]*)" \/>$/;
const TEXT_ATTACHMENT = /^<attachment name="([^"]*)" media-type="([^"]*)">\n[\s\S]*\n<\/attachment>$/;

const unescapeAttr = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const atOf = (m: Loose): string | null => (typeof m.timestamp === "string" ? m.timestamp : null);

export function historyEntries(messages: readonly SessionMessage[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const tools = new Map<string, number>();
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  const tasks = new Map<string, TaskActivity>();
  const taskPositions = new Map<string, number>();
  const noticeState = createMapState();
  const addTask = (m: Loose) => {
    for (const event of taskEvents(tasks, m, true)) {
      if (event.type !== "task") continue;
      const task = event.task;
      const id = taskKey(task);
      const entry: TranscriptEntry = { kind: "task", id, task, at: task.startedAt ?? task.completedAt, parentToolUseId: task.parentToolUseId };
      const index = taskPositions.get(id);
      if (index !== undefined) entries[index] = entry;
      else { taskPositions.set(id, entries.length); entries.push(entry); }
    }
  };
  for (const [at, raw] of messages.entries()) {
    const m = raw as SessionMessage & Loose;
    const parent = m.parent_tool_use_id ?? null;
    const message: Loose = (m.message as Loose) ?? {};
    if (m.type === "system") {
      if (["task_started", "task_updated", "task_progress", "task_notification", "background_tasks_changed"].includes(m.subtype)) addTask(m);
      else for (const event of mapMessage(noticeState, m)) if (event.type === "notice") {
        const id = String(m.uuid ?? `system:${entries.length}`);
        if (!ids.has(id)) {
          ids.add(id);
          entries.push({ kind: "system", id, level: event.level, text: event.text, at: atOf(m), parentToolUseId: parent });
        }
      }
      continue;
    }
    if (m.type === "assistant") {
      for (const entry of assistantEntries(message, counts, parent, atOf(m))) {
        if (entry.kind === "tool") tools.set(entry.id, entries.length);
        entries.push(entry);
      }
    } else if (m.type === "user") {
      if (m.isMeta || m.isSynthetic) continue;
      if (isInterruptMessage((m.message as Loose)?.content)) continue;
      const content = message.content;
      const texts: string[] = [];
      const attachments: { name: string; mediaType: string }[] = [];
      const notices: TaskNotice[] = [];
      const injected: Injected[] = [];
      const locals: LocalCommandParts[] = [];
      const addText = (text: string) => {
        const found = parseTaskNotifications(text);
        const local = found ? null : parseLocalCommand(text);
        if (found) notices.push(...found);
        else if (local) locals.push(local);
        else if (text.trim() && !stripSystemReminders(text)) return;
        else {
          const inj = injectedMessage(m, text);
          if (inj) injected.push(inj);
          else texts.push(text);
        }
      };
      if (typeof content === "string") addText(content);
      else if (Array.isArray(content)) {
        let announced: { name: string; mediaType: string } | null = null;
        for (const b of content as Loose[]) {
          if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
            const i = tools.get(b.tool_use_id);
            const cur = i === undefined ? undefined : entries[i];
            if (cur?.kind === "tool") entries[i!] = { ...cur, result: toToolResult(b, { interruptedNext: isInterruptMessage((messages[at + 1] as Loose | undefined)?.message?.content) }) };
            continue;
          }
          if (b?.type === "text" && typeof b.text === "string") {
            const img = IMAGE_TAG.exec(b.text);
            if (img) {
              announced = { name: unescapeAttr(img[1]!), mediaType: unescapeAttr(img[2]!) };
              continue;
            }
            const file = TEXT_ATTACHMENT.exec(b.text);
            if (file) attachments.push({ name: unescapeAttr(file[1]!), mediaType: unescapeAttr(file[2]!) });
            else addText(b.text);
          } else if (b?.type === "image") {
            attachments.push(announced ?? { name: "image", mediaType: String(b.source?.media_type ?? "image") });
          }
          if (b?.type !== "text") announced = null;
        }
      }
      notices.forEach((n, i) => {
        if (n.taskId) {
          addTask({ subtype: "task_notification", task_id: n.taskId, tool_use_id: n.toolUseId, status: n.status, summary: n.summary, run_id: m.origin?.runId, timestamp: m.timestamp });
          return;
        }
        let id = taskNoticeId(n, m.uuid, i);
        if (ids.has(id)) id = `${m.uuid}:notice:${i}`;
        ids.add(id);
        entries.push(taskNoticeEntry(n, id, atOf(m), parent));
      });
      for (const l of locals) if (l.typed) entries.push({ kind: "user", id: locals.length > 1 || l.outputs.length ? `${m.uuid}:typed` : m.uuid, text: l.typed, at: atOf(m), parentToolUseId: parent });
      entries.push(...localOutputEntries(locals, m.uuid, atOf(m), parent));
      injected.forEach((inj, i) => entries.push(injectedEntry(inj, injectedId(m.uuid, i, injected.length), atOf(m), parent)));
      // A message carrying a notification wasn't typed by the user: no reminders in what's left of it.
      if (notices.length) texts.splice(0, texts.length, ...texts.map(stripSystemReminders).filter(Boolean));
      if (!texts.length && !attachments.length) continue;
      entries.push({
        kind: "user",
        id: m.uuid,
        text: texts.join("\n"),
        ...(attachments.length ? { attachments } : {}),
        at: atOf(m),
        parentToolUseId: parent,
      });
    }
  }
  return entries;
}
