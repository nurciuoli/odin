import type { SessionMessageInfo, SessionMessageAssistantTool, TokenUsageInfo, PermissionRequest as NativePermission } from "@opencode/client";
import type { TokenUsage } from "@odin/shared/api";
import { TOOL_RESULT_MAX_CHARS, type PermissionRequest, type ToolResult, type TranscriptEntry } from "@odin/shared/harness";

export const timestamp = (value?: number): string | null => value === undefined ? null : new Date(value).toISOString();
export const modelValue = (model: { providerID: string; id: string }): string => `${model.providerID}/${model.id}`;
export const contentId = (message: string, ordinal: number): string => `${message}:${ordinal}`;
export function tokenUsage(tokens: TokenUsageInfo): TokenUsage {
  // OpenCode output already includes reasoning; cache counters are separate from fresh input.
  return { input: tokens.input, output: tokens.output, cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write };
}
export function result(text: string, ok: boolean): ToolResult {
  return { text: text.slice(0, TOOL_RESULT_MAX_CHARS), ok, truncated: text.length > TOOL_RESULT_MAX_CHARS };
}
export function toolEntry(tool: SessionMessageAssistantTool): TranscriptEntry {
  const state = tool.state;
  const text = state.status === "completed" || state.status === "error"
    ? (state.content ?? []).map(item => item.type === "text" ? item.text : `[file: ${item.name ?? item.mime}]`).join("\n")
    : null;
  return {
    kind: "tool", id: tool.id, name: tool.name,
    input: state.status === "streaming" ? {} : state.input,
    at: timestamp(tool.time.created), parentToolUseId: null,
    ...(text !== null ? { result: result(state.status === "error" ? state.error.message + (text ? `\n${text}` : "") : text, state.status !== "error") } : {}),
  };
}
export function messageEntries(message: SessionMessageInfo): TranscriptEntry[] {
  const base = { at: timestamp(message.time.created), parentToolUseId: null };
  switch (message.type) {
    case "user": return [{ ...base, kind: "user", id: message.id, text: message.text, ...(message.files?.length ? { attachments: message.files.map(file => ({ name: file.name ?? "attachment", mediaType: file.mime })) } : {}) }];
    case "synthetic": return [{ ...base, kind: "injected", id: message.id, source: message.metadata?.source === "subagent" ? "agent" : "system", from: typeof message.metadata?.agent === "string" ? message.metadata.agent : null, text: message.text }];
    case "system": return [{ ...base, kind: "system", id: message.id, level: "info", text: message.text }];
    case "assistant": return message.content.map((part, index): TranscriptEntry => {
      if (part.type === "tool") return toolEntry(part);
      if (part.type === "reasoning") return { ...base, kind: "thinking", id: contentId(message.id, index), text: part.text };
      return { ...base, kind: "assistant", id: contentId(message.id, index), text: part.text, model: modelValue(message.model) };
    });
    case "shell": return [{ ...base, kind: "tool", id: message.id, name: "shell", input: { command: message.command }, ...(message.status !== "running" ? { result: result(message.output?.output ?? "", message.status === "exited" && message.exit === 0) } : {}) }];
    case "compaction": return [{ ...base, kind: "system", id: message.id, level: message.status === "failed" ? "error" : "info", text: message.status === "failed" ? `Compaction failed: ${message.error.message}` : `Compaction ${message.status}: ${message.summary}` }];
    case "agent-switched": return [{ ...base, kind: "system", id: message.id, level: "info", text: `Agent: ${message.agent}` }];
    case "model-switched": return [{ ...base, kind: "system", id: message.id, level: "info", text: `Model: ${modelValue(message.model)}` }];
    case "location-switched": return [{ ...base, kind: "system", id: message.id, level: "info", text: `Directory: ${message.location.directory}` }];
    case "skill": return [{ ...base, kind: "system", id: message.id, level: "info", text: `Skill: ${message.name}` }];
    case "idle": return [];
  }
}
export function permissionRequest(value: NativePermission, sessionId: string, createdAt: string): PermissionRequest {
  return {
    id: value.id, sessionId, kind: "tool", toolName: value.action, toolUseId: value.source?.id ?? null,
    input: { action: value.action, resources: value.resources, save: value.save ?? [] },
    title: value.message ?? `Allow ${value.action}?`,
    description: "Always allow saves OpenCode's proposed patterns for this project. Deny also rejects other pending permissions in this session.",
    canAlwaysAllow: !!value.save?.length, defaultToDeny: true, createdAt,
  };
}

/** Unbounded only for the lifetime of a consuming live handle; close releases all waiters. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  private ended = false;
  push(value: T): void { if (!this.ended) { const next = this.waiting.shift(); if (next) next({ value, done: false }); else this.items.push(value); } }
  end(): void { this.ended = true; for (const next of this.waiting.splice(0)) next({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => this.items.length ? Promise.resolve({ value: this.items.shift()!, done: false }) : this.ended ? Promise.resolve({ value: undefined, done: true }) : new Promise(resolve => this.waiting.push(resolve)) }; }
}
