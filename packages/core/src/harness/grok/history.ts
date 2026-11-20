// On-disk Grok sessions. ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/. No live process.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AttachmentContent, HarnessSessionInfo } from "../types.ts";
import { historyAttachment, historyEntries, tasksFromUpdates, userText } from "./map.ts";
import type { Wire } from "./transport.ts";
import type { TranscriptEntry } from "@odin/shared/harness";

export function encodedCwd(cwd: string): string {
  return encodeURIComponent(cwd);
}

interface Summary {
  info?: { id?: unknown; cwd?: unknown };
  created_at?: unknown;
  updated_at?: unknown;
  current_model_id?: unknown;
  session_summary?: unknown;
  generated_title?: unknown;
  session_kind?: unknown;
}

function readSummary(dir: string): Summary | null {
  try {
    return JSON.parse(readFileSync(join(dir, "summary.json"), "utf8")) as Summary;
  } catch {
    return null;
  }
}

function firstUserText(dir: string): string {
  try {
    const lines = readFileSync(join(dir, "chat_history.jsonl"), "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== "user") continue;
      const text = userText(row);
      const trimmed = text.trim().split("\n")[0] ?? "";
      if (trimmed) return trimmed.slice(0, 80);
    }
  } catch {
    /* Missing history is an empty title. */
  }
  return "";
}

export function sessionInfo(dir: string): HarnessSessionInfo | null {
  const summary = readSummary(dir);
  const id = summary?.info?.id;
  if (typeof id !== "string" || !id) return null;
  const generated = typeof summary.generated_title === "string" ? summary.generated_title.trim() : "";
  const summaryTitle = typeof summary.session_summary === "string" ? summary.session_summary.trim() : "";
  const title = (generated || summaryTitle || firstUserText(dir) || "Grok session").slice(0, 200);
  const updated = typeof summary.updated_at === "string" ? summary.updated_at : new Date(0).toISOString();
  return {
    sessionId: id,
    title,
    firstPrompt: firstUserText(dir) || null,
    cwd: typeof summary.info?.cwd === "string" ? summary.info.cwd : null,
    gitBranch: null,
    createdAt: typeof summary.created_at === "string" ? summary.created_at : null,
    updatedAt: updated,
  };
}

export function listSessions(historyRoot: string, projectPath: string): HarnessSessionInfo[] {
  const dir = join(historyRoot, encodedCwd(projectPath));
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: HarnessSessionInfo[] = [];
  for (const name of names) {
    const child = join(dir, name);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    const summary = readSummary(child);
    // Subagent conversations live beside the parent. They are opened from the parent's task, not imported as sessions.
    if (summary?.session_kind === "subagent") continue;
    const info = sessionInfo(child);
    // ACP session/new can create a native record before a prompt is ever sent.
    if (info?.firstPrompt) sessions.push(info);
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function readJsonl(file: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

export function readAttachment(historyRoot: string, projectPath: string, sessionId: string, entryId: string, index: number): AttachmentContent | null {
  const dir = join(historyRoot, encodedCwd(projectPath), sessionId);
  return historyAttachment(readJsonl(join(dir, "chat_history.jsonl")) as Wire[], entryId, index);
}

export function readMessages(historyRoot: string, projectPath: string, sessionId: string): TranscriptEntry[] {
  const dir = join(historyRoot, encodedCwd(projectPath), sessionId);
  const messages = historyEntries(readJsonl(join(dir, "chat_history.jsonl")) as Wire[]);
  const tasks = tasksFromUpdates(readJsonl(join(dir, "updates.jsonl")));
  return [...messages, ...tasks];
}

/** Child transcript when `childId` is a subagent of this parent under the same project directory. */
export function readOwnedChild(historyRoot: string, projectPath: string, parentId: string, childId: string): TranscriptEntry[] | null {
  if (!parentId || !childId || parentId === childId) return null;
  const root = join(historyRoot, encodedCwd(projectPath));
  const summary = readSummary(join(root, childId));
  if (summary?.session_kind !== "subagent") return null;
  let owned = false;
  for (const name of ["chat_history.jsonl", "updates.jsonl"]) {
    try {
      if (readFileSync(join(root, parentId, name), "utf8").includes(childId)) owned = true;
    } catch {
      /* The other file may still name the child. */
    }
  }
  if (!owned) return null;
  return readMessages(historyRoot, projectPath, childId);
}
