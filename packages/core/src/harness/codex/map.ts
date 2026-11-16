import type { PermissionMode, UserMessage } from "@odin/shared/api";
import type { TranscriptEntry } from "@odin/shared/harness";
import { toolResult as sharedToolResult } from "@odin/shared/transcript";
import type { Wire } from "./transport.ts";

export const CODEX_MODES: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "dontAsk",
  "bypassPermissions",
];

export function policy(mode: PermissionMode): Wire {
  if (!CODEX_MODES.includes(mode))
    throw new Error(`Codex does not support permission mode ${mode}`);
  if (mode === "bypassPermissions")
    return { approvalPolicy: "never", sandbox: "danger-full-access" };
  if (mode === "dontAsk")
    return { approvalPolicy: "never", sandbox: "workspace-write" };
  if (mode === "plan")
    return { approvalPolicy: "on-request", sandbox: "read-only" };
  return {
    approvalPolicy: mode === "default" ? "untrusted" : "on-request",
    sandbox: "workspace-write",
  };
}

export function userInput(message: UserMessage): Wire[] {
  const content: Wire[] = [{ type: "text", text: message.text }];
  for (const a of message.attachments ?? []) {
    if (a.mediaType.startsWith("image/"))
      content.push({
        type: "image",
        url: `data:${a.mediaType};base64,${a.data}`,
      });
    else
      content.push({
        type: "text",
        text: `<attachment name=${JSON.stringify(a.name)}>\n${a.data}\n</attachment>`,
      });
  }
  return content;
}

const printable = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value ?? "");
const toolResult = (text: string, ok: boolean) => sharedToolResult(ok, text);

/** The same mapping is used for completed live items and stored history. Native item IDs are never regenerated. */
export function itemEntry(
  item: Wire,
  model: string | null,
  completed = true,
): TranscriptEntry | null {
  if (typeof item.id !== "string") return null;
  const base = {
    id: item.id,
    at:
      typeof item.startedAtMs === "number"
        ? new Date(item.startedAtMs).toISOString()
        : null,
    parentToolUseId: null,
  };
  switch (item.type) {
    // Lifecycle signals have a normalized task card; never render a generic system line per tick.
    case "subAgentActivity":
    case "SubAgentActivity":
      return null;
    case "userMessage":
      return {
        ...base,
        kind: "user",
        text: (item.content ?? [])
          .filter((c: Wire) => c.type === "text")
          .map((c: Wire) => c.text)
          .join("\n"),
        attachments: (item.content ?? [])
          .filter((c: Wire) => c.type === "image" || c.type === "localImage")
          .map(() => ({ name: "Image", mediaType: "image/*" })),
      };
    case "agentMessage":
      return { ...base, kind: "assistant", text: item.text ?? "", model };
    case "plan":
      return { ...base, kind: "assistant", text: item.text ?? "", model };
    case "reasoning":
      return {
        ...base,
        kind: "thinking",
        text: (item.summary?.length ? item.summary : (item.content ?? [])).join(
          "\n",
        ),
      };
    case "commandExecution":
      return {
        ...base,
        kind: "tool",
        name: "Bash",
        input: { command: item.command, cwd: item.cwd },
        ...(completed
          ? {
              result: toolResult(
                item.aggregatedOutput ?? "",
                item.status !== "failed" &&
                  item.status !== "declined" &&
                  (item.exitCode == null || item.exitCode === 0),
              ),
            }
          : {}),
      };
    case "fileChange":
      return {
        ...base,
        kind: "tool",
        name: "Edit",
        input: { file_path: item.changes?.[0]?.path, changes: item.changes },
        ...(completed
          ? {
              result: toolResult(
                (item.changes ?? []).map((c: Wire) => c.diff).join("\n"),
                item.status === "completed",
              ),
            }
          : {}),
      };
    case "mcpToolCall":
      return {
        ...base,
        kind: "tool",
        name: `mcp__${item.server}__${item.tool}`,
        input: item.arguments ?? {},
        ...(completed
          ? {
              result: toolResult(
                printable(item.result ?? item.error),
                item.status === "completed" && !item.error,
              ),
            }
          : {}),
      };
    case "dynamicToolCall":
      return {
        ...base,
        kind: "tool",
        name: item.tool,
        input: item.arguments ?? {},
        ...(completed
          ? {
              result: toolResult(
                (item.contentItems ?? [])
                  .map((c: Wire) => c.text ?? "[image]")
                  .join("\n"),
                item.success !== false,
              ),
            }
          : {}),
      };
    case "collabAgentToolCall":
      return {
        ...base,
        kind: "tool",
        name: "Agent",
        input: { description: item.prompt ?? item.tool, ...item },
        ...(completed
          ? {
              result: toolResult(
                printable(item.agentsStates),
                item.status !== "failed",
              ),
            }
          : {}),
      };
    case "enteredReviewMode":
      return { ...base, kind: "system", level: "info", text: item.review ? `Reviewing: ${item.review}` : "Review started" };
    case "exitedReviewMode":
      // The finished review (from /review) reads as the assistant's reply.
      return { ...base, kind: "assistant", text: item.review ?? "", model };
    case "contextCompaction":
      return {
        ...base,
        kind: "system",
        level: "info",
        text: "Context compacted",
      };
    default:
      return {
        ...base,
        kind: "system",
        level: "info",
        text: `Codex: ${item.type}`,
      };
  }
}

export { EventQueue } from "../queue.ts";
