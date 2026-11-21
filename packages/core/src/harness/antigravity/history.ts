// On-disk Antigravity sessions. ~/.gemini/antigravity-cli/brain/<id>/. No live process.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { HarnessSessionInfo } from "../types.ts";
import type { TranscriptEntry } from "@odin/shared/harness";
import { toolCallInput, toolCallName, toolResult } from "./map.ts";

export function defaultHistoryRoot(): string {
  return process.env.AGY_BRAIN_DIR || join(homedir(), ".gemini", "antigravity-cli", "brain");
}

interface RawStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: string;
  model?: string;
  thinking?: string;
  tool_calls?: { name: string; args?: Record<string, unknown> }[];
}

function cleanUserContent(content?: string): string {
  if (!content) return "";
  let text = content;
  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(text);
  if (match?.[1]) text = match[1];
  return text.trim();
}

function readTranscriptLines(logDir: string): RawStep[] {
  const fullPath = join(logDir, "transcript_full.jsonl");
  const compactPath = join(logDir, "transcript.jsonl");
  const file = existsSync(fullPath) ? fullPath : existsSync(compactPath) ? compactPath : null;
  if (!file) return [];
  try {
    const raw = readFileSync(file, "utf8");
    return raw.split(/\r?\n/).flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as RawStep];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function sessionInfo(historyRoot: string, sessionId: string): HarnessSessionInfo | null {
  const dir = join(historyRoot, sessionId);
  try {
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const logDir = join(dir, ".system_generated", "logs");
  const steps = readTranscriptLines(logDir);
  const firstUser = steps.find((s) => s.type === "USER_INPUT");
  const firstText = cleanUserContent(firstUser?.content);
  const title = (firstText.split("\n")[0] || "Antigravity session").slice(0, 200);
  const hasTimestamp = (step: RawStep) => Number.isFinite(Date.parse(step.created_at ?? ""));
  const createdAt = (firstUser && hasTimestamp(firstUser) ? firstUser : steps.find(hasTimestamp))?.created_at ?? null;
  const updatedAt = steps.findLast(hasTimestamp)?.created_at ?? new Date(0).toISOString();

  return {
    sessionId,
    title,
    firstPrompt: firstText || null,
    cwd: null,
    gitBranch: null,
    createdAt,
    updatedAt,
  };
}

export function listSessions(historyRoot: string): HarnessSessionInfo[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(historyRoot);
  } catch {
    return [];
  }
  const sessions: HarnessSessionInfo[] = [];
  for (const id of ids) {
    const info = sessionInfo(historyRoot, id);
    if (info?.firstPrompt) sessions.push(info);
  }
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function readMessages(historyRoot: string, sessionId: string): TranscriptEntry[] {
  const logDir = join(historyRoot, sessionId, ".system_generated", "logs");
  const steps = readTranscriptLines(logDir);
  const entries: TranscriptEntry[] = [];
  const openTools: { id: string; tool: Extract<TranscriptEntry, { kind: "tool" }> }[] = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const id = `agy-${step.step_index ?? i}`;
    const at = step.created_at ?? null;

    if (step.type === "USER_INPUT") {
      const text = cleanUserContent(step.content);
      if (text) {
        entries.push({ kind: "user", id, text, at, parentToolUseId: null });
      }
    } else if (step.type === "PLANNER_RESPONSE") {
      if (step.thinking) {
        entries.push({ kind: "thinking", id: `${id}-thought`, text: step.thinking, at, parentToolUseId: null });
      }
      if (step.content) {
        entries.push({ kind: "assistant", id: `${id}-reply`, text: step.content, model: step.model ?? null, at, parentToolUseId: null });
      }
      for (let t = 0; t < (step.tool_calls?.length ?? 0); t++) {
        const call = step.tool_calls![t]!;
        const toolId = `${id}-tool-${t}`;
        const name = toolCallName({ name: call.name });
        const input = toolCallInput({ rawInput: call.args });
        const toolEntry: Extract<TranscriptEntry, { kind: "tool" }> = {
          kind: "tool",
          id: toolId,
          name,
          input,
          at,
          parentToolUseId: null,
        };
        openTools.push({ id: toolId, tool: toolEntry });
        entries.push(toolEntry);
      }
    } else if (step.type === "GENERIC" && step.source === "MODEL") {
      // Tool execution result
      const open = openTools.shift();
      if (open) {
        const text = step.content ?? "";
        open.tool.result = toolResult(text, step.status === "DONE");
      }
    }
  }

  return entries;
}
