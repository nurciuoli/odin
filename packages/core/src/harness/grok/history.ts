// On-disk Grok sessions. ~/.grok/sessions/<encodeURIComponent(cwd)>/<id>/. No live process.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { HarnessSessionInfo } from "../types.ts";
import { historyEntries, userText } from "./map.ts";
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
  const summaryTitle = typeof summary.session_summary === "string" ? summary.session_summary.trim() : "";
  const title = (summaryTitle || firstUserText(dir) || "Grok session").slice(0, 200);
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
    const info = sessionInfo(child);
    // ACP session/new can create a native record before a prompt is ever sent.
    if (info?.firstPrompt) sessions.push(info);
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readMessages(historyRoot: string, projectPath: string, sessionId: string): TranscriptEntry[] {
  const file = join(historyRoot, encodedCwd(projectPath), sessionId, "chat_history.jsonl");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  return historyEntries(lines);
}
