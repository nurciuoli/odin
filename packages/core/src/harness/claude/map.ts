// Pure mapping from the SDK's message stream to HarnessEvents. A small state object carries what the stream itself
// doesn't repeat: whether `init` went out, the current model/mode/state, the block index per assistant message id
// (entry ids are `<message.id>:<content block index>`, the same for deltas, whole entries and history), the last
// main-thread usage (for contextTokens) and what the turn's usage report is measured against. docs/contracts.md#harness.
//
// Usage: `result.modelUsage` is cumulative for the CLI process, starting from totals it restores on a resume or a
// fork. Those restored totals are whatever the CLI last saved, which lags when the parent's own process is still
// running (observed live: a fork restored the parent as of two turns earlier). So the driver reports each turn's own
// usage (`cumulative: false`): the difference from the previous result in the same process, or, for the first result
// of a resumed/forked process, the sum of that turn's assistant message usage.
import { injectedMessage, type Injected } from "./injected.ts";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionMode, Todo, TokenUsage } from "@odin/shared/api";
import type { HarnessEvent, ToolResult, TranscriptEntry } from "@odin/shared/harness";
import { toolResult } from "@odin/shared/transcript";
import { DEFAULT_DENY_MESSAGE } from "./permissions.ts";
import { taskEvents } from "./activity.ts";
import { slashCommandsFromNames, slashCommandsFromSdk } from "./commands.ts";
import type { SlashCommand } from "@odin/shared/harness";
import type { TaskActivity } from "@odin/shared/harness";

export type LiveState = "running" | "idle" | "waiting";

export interface MapState {
  tasks: Map<string, TaskActivity>;
  initSent: boolean;
  model: string | null;
  permissionMode: PermissionMode | null;
  /** The last `state` event sent (null before any). */
  state: LiveState | null;
  /** Blocks seen so far per assistant message id. */
  blockCounts: Map<string, number>;
  /** The message id currently streaming, per parent tool use ("" for the main thread). */
  streaming: Map<string, string>;
  /** Context size from the last main-thread assistant message: input + cache read + cache write. */
  contextTokens: number | null;
  contextModel: string | null;
  /**
   * The CLI's cumulative usage per model at the previous result of this process. `null` while a resumed or forked
   * process hasn't reported yet: its starting totals are unknown.
   */
  usageBase: Map<string, { usage: TokenUsage; costUsd: number | null }> | null;
  /** This turn's assistant message usage by message id (largest value seen per field). */
  turnUsage: Map<string, { model: string | null; usage: TokenUsage }>;
  /** The full command list from the initialize response, once known (init's own list has names only). */
  commands: SlashCommand[] | null;
}

export function createMapState(options: { resumed?: boolean } = {}): MapState {
  return {
    tasks: new Map(),
    usageBase: options.resumed ? null : new Map(),
    turnUsage: new Map(),
    initSent: false,
    model: null,
    permissionMode: null,
    state: null,
    blockCounts: new Map(),
    streaming: new Map(),
    contextTokens: null,
    contextModel: null,
    commands: null,
  };
}

/**
 * The full command list arrived (initialize response or `supportedCommands()`): kept for `init`, or sent as
 * `commands` once `init` is out.
 */
export function commandsKnown(state: MapState, list: unknown): HarnessEvent[] {
  state.commands = slashCommandsFromSdk(list);
  return state.initSent ? [{ type: "commands", slashCommands: state.commands }] : [];
}

/** A `state` event when it differs from the last one sent, else nothing. */
export function setState(state: MapState, next: LiveState): HarnessEvent[] {
  if (state.state === next) return [];
  state.state = next;
  return [{ type: "state", state: next }];
}

/** Anything the mapping reads: loose on purpose, the CLI sends message types newer than the SDK's union. */
type Loose = Record<string, any>;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Text of a tool_result content (a string or blocks); images become "[image]". */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: Loose) => (b?.type === "text" ? String(b.text ?? "") : b?.type === "image" ? "[image]" : ""))
    .filter((s) => s !== "")
    .join("\n");
}

/** What the CLI says when the user refused a call or interrupted the turn (prose written for the model). */
const REJECT_PREFIX = "The user doesn't want to proceed with this tool use";
const STOPPED_RUNNING = "stopped while running";
const CLASSIFIER_DENIAL = "Permission for this action was denied by the Claude Code auto mode classifier";
/** The standing "[Request interrupted…]" user text the CLI records after an interrupt: never the user's own words. */
const INTERRUPT_MARKER = /^\[Request interrupted by user( for tool use)?\]$/;
const LABEL_MAX = 300;

export function isInterruptMarker(text: string): boolean {
  return INTERRUPT_MARKER.test(text.trim());
}

/** True when a stored/live user message holds only the interrupt marker text. */
export function isInterruptMessage(content: unknown): boolean {
  if (typeof content === "string") return isInterruptMarker(content);
  if (!Array.isArray(content) || !content.length) return false;
  return (content as Loose[]).every((b) => b?.type === "text" && typeof b.text === "string" && isInterruptMarker(b.text));
}

const shortReason = (text: string, fallback: string): string => {
  const t = text.trim();
  if (!t || t.startsWith(REJECT_PREFIX)) return fallback;
  return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX - 1)}…` : t;
};

export interface ToolResultHints {
  /** The message's `tool_use_result` (live only). */
  toolUseResult?: unknown;
  /** The message's `tool_result_meta` (live only). */
  meta?: unknown;
  /** The next record is the interrupt marker (history, where no structured fields are stored). */
  interruptedNext?: boolean;
}

/**
 * The one classifier for tool results, live and stored. Live messages carry `tool_result_meta`; stored ones only have
 * `is_error` and the prose, so that is the fallback. A user-refused or interrupted call stays `ok: false` and gets a
 * short label instead of the model-directed prose.
 */
export function toToolResult(block: Loose, hints: ToolResultHints = {}): ToolResult {
  const text = toolResultText(block.content);
  if (!block.is_error) return toolResult(true, text);
  const meta = Array.isArray(hints.meta) ? (hints.meta as Loose[]).find((x) => x?.id === block.tool_use_id) : undefined;
  const kind = str(meta?.non_execution_kind);
  const stopped = text.includes(STOPPED_RUNNING);
  if (meta && (kind === "user-rejected" || kind === "permission-rule" || meta.permission_decision?.decision === "reject")) {
    if (kind === "user-rejected" || stopped) return toolResult(false, "Stopped by you", "interrupted");
    return toolResult(false, shortReason(text, "Denied"), "denied");
  }
  if (text.startsWith(CLASSIFIER_DENIAL)) return toolResult(false, shortReason(text, "Denied"), "denied");
  if (text.startsWith(REJECT_PREFIX) || hints.toolUseResult === "User rejected tool use") {
    return stopped || hints.interruptedNext ? toolResult(false, "Stopped by you", "interrupted") : toolResult(false, "Denied", "denied");
  }
  if (!meta && text === DEFAULT_DENY_MESSAGE) return toolResult(false, "Denied", "denied");
  return toolResult(false, text);
}

const TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use"]);

/**
 * The entries of one assistant message (the SDK sends one message per completed block; several can share a message
 * id). `counts` tracks the block index per message id across those messages.
 */
export function assistantEntries(message: Loose, counts: Map<string, number>, parentToolUseId: string | null, at: string | null): TranscriptEntry[] {
  const id = str(message?.id) ?? "msg";
  const model = str(message?.model);
  const content: Loose[] = Array.isArray(message?.content) ? message.content : [];
  const out: TranscriptEntry[] = [];
  for (const block of content) {
    const index = counts.get(id) ?? 0;
    counts.set(id, index + 1);
    const entryId = `${id}:${index}`;
    if (block?.type === "text") {
      out.push({ kind: "assistant", id: entryId, text: String(block.text ?? ""), model, at, parentToolUseId });
    } else if (block?.type === "thinking") {
      out.push({ kind: "thinking", id: entryId, text: String(block.thinking ?? ""), at, parentToolUseId });
    } else if (TOOL_BLOCKS.has(block?.type)) {
      const input = block.input && typeof block.input === "object" ? (block.input as Record<string, unknown>) : {};
      out.push({ kind: "tool", id: String(block.id ?? entryId), name: String(block.name ?? "tool"), input, at, parentToolUseId });
    }
  }
  return out;
}

const TODO_STATES = new Set(["pending", "in_progress", "completed"]);

/** TodoWrite's input as todos, or null when it isn't a todo list. */
export function todosFrom(input: Record<string, unknown>): Todo[] | null {
  if (!Array.isArray(input.todos)) return null;
  const todos: Todo[] = [];
  for (const t of input.todos as Loose[]) {
    if (!t || typeof t.content !== "string" || !TODO_STATES.has(t.status)) continue;
    todos.push(typeof t.activeForm === "string" ? { content: t.content, status: t.status, activeForm: t.activeForm } : { content: t.content, status: t.status });
  }
  return todos;
}

const ZERO: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const minus = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: Math.max(0, a.input - b.input),
  output: Math.max(0, a.output - b.output),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite),
});
const plus = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});
const isZero = (u: TokenUsage) => !u.input && !u.output && !u.cacheRead && !u.cacheWrite;
/**
 * Relative token weights (input 1, output 5, cache read 0.1, cache write 1.25: the ratios Anthropic prices share
 * across models). Only used to split the harness's cost when a resumed process's starting cost is unknown.
 */
const weight = (u: TokenUsage) => u.input + 5 * u.output + 0.1 * u.cacheRead + 1.25 * u.cacheWrite;

/** An API message's `usage` (snake_case) as TokenUsage. */
function apiUsage(u: Loose): TokenUsage {
  return {
    input: Number(u.input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
    cacheRead: Number(u.cache_read_input_tokens ?? 0),
    cacheWrite: Number(u.cache_creation_input_tokens ?? 0),
  };
}

function usageOf(u: Loose): TokenUsage {
  return {
    input: Number(u.inputTokens ?? 0),
    output: Number(u.outputTokens ?? 0),
    cacheRead: Number(u.cacheReadInputTokens ?? 0),
    cacheWrite: Number(u.cacheCreationInputTokens ?? 0),
  };
}

/** An interrupt (by the user, in the CLI's eyes) ends the turn with `error_during_execution` and `terminal_reason: aborted_*`. */
export function isAbortResult(m: Loose): boolean {
  return m.subtype === "error_during_execution" && typeof m.terminal_reason === "string" && m.terminal_reason.startsWith("aborted_");
}

function resultError(m: Loose): string | null {
  if (!m.is_error && m.subtype === "success") return null;
  if (Array.isArray(m.errors) && m.errors.length) return m.errors.map(String).join("; ");
  if (m.subtype === "success") return str(m.result) || "error";
  return String(m.subtype ?? "error");
}

function rateLimitNotice(info: Loose): HarnessEvent[] {
  if (info?.status !== "rejected") return [];
  const kind = typeof info.rateLimitType === "string" ? ` (${info.rateLimitType.replace(/_/g, " ")})` : "";
  const resets = typeof info.resetsAt === "number" ? `; resets ${new Date(info.resetsAt * 1000).toISOString()}` : "";
  return [{ type: "notice", level: "error", text: `Rate limit reached${kind}${resets}` }];
}

function systemMessage(state: MapState, m: Loose): HarnessEvent[] {
  switch (m.subtype) {
    case "init": {
      const model = str(m.model);
      const mode = (str(m.permissionMode) as PermissionMode | null) ?? null;
      if (!state.initSent) {
        state.initSent = true;
        state.model = model;
        state.permissionMode = mode;
        return [{
          type: "init",
          sessionId: String(m.session_id ?? ""),
          model,
          permissionMode: mode,
          cwd: String(m.cwd ?? ""),
          tools: Array.isArray(m.tools) ? m.tools.map(String) : [],
          slashCommands: state.commands ?? slashCommandsFromNames(m.slash_commands),
          agents: Array.isArray(m.agents) ? m.agents.map(String) : [],
        }];
      }
      const out: HarnessEvent[] = [];
      if (model && model !== state.model) {
        state.model = model;
        out.push({ type: "model", model });
      }
      if (mode && mode !== state.permissionMode) {
        state.permissionMode = mode;
        out.push({ type: "permission.mode", mode });
      }
      return out;
    }
    case "status": {
      const out: HarnessEvent[] = [];
      const mode = str(m.permissionMode) as PermissionMode | null;
      if (mode && mode !== state.permissionMode) {
        state.permissionMode = mode;
        out.push({ type: "permission.mode", mode });
      }
      if (m.status === "requesting" && state.state !== "waiting") out.push(...setState(state, "running"));
      if (m.compact_result === "failed") out.push({ type: "notice", level: "error", text: `Compaction failed${m.compact_error ? `: ${m.compact_error}` : ""}` });
      return out;
    }
    case "api_retry": {
      const cause = m.error_status != null ? `HTTP ${m.error_status}` : String(m.error ?? "connection error");
      const secs = Math.round(Number(m.retry_delay_ms ?? 0) / 1000);
      return [{ type: "notice", level: "warning", text: `API error (${cause}); retrying in ${secs}s (attempt ${m.attempt}/${m.max_retries})` }];
    }
    case "compact_boundary": {
      const meta: Loose = m.compact_metadata ?? {};
      const pre = typeof meta.pre_tokens === "number" ? `, ${meta.pre_tokens} tokens before` : "";
      return [{ type: "notice", level: "info", text: `Conversation compacted (${meta.trigger ?? "auto"}${pre})` }];
    }
    case "task_started":
    case "task_progress":
    case "task_updated":
    case "background_tasks_changed":
      return taskEvents(state.tasks, m);
    case "task_notification":
      return taskEvents(state.tasks, m);
    case "commands_changed":
      return commandsKnown(state, m.commands);
    case "local_command_output": {
      // Output of a local command such as /context or /usage: shown as assistant text.
      const text = typeof m.content === "string" ? m.content : "";
      if (!text) return [];
      return [{ type: "entry", entry: { kind: "assistant", id: String(m.uuid ?? `local:${Date.now()}`), text, model: null, at: new Date().toISOString(), parentToolUseId: null } }];
    }
    default:
      return [];
  }
}

function streamEvent(state: MapState, m: Loose): HarnessEvent[] {
  const ev: Loose = m.event ?? {};
  const parent = str(m.parent_tool_use_id);
  const key = parent ?? "";
  if (ev.type === "message_start") {
    const id = str(ev.message?.id);
    if (id) state.streaming.set(key, id);
    return [];
  }
  if (ev.type !== "content_block_delta") return [];
  const messageId = str(m.api_message_id) ?? state.streaming.get(key);
  if (!messageId) return [];
  const entryId = `${messageId}:${ev.index ?? 0}`;
  const d: Loose = ev.delta ?? {};
  if (d.type === "text_delta" && d.text) return [{ type: "delta", entryId, kind: "assistant", text: String(d.text), parentToolUseId: parent }];
  if (d.type === "thinking_delta" && d.thinking) return [{ type: "delta", entryId, kind: "thinking", text: String(d.thinking), parentToolUseId: parent }];
  return [];
}

function assistantMessage(state: MapState, m: Loose): HarnessEvent[] {
  const parent = str(m.parent_tool_use_id);
  const message: Loose = m.message ?? {};
  const messageId = str(message.id);
  if (messageId && message.usage) {
    // One SDK message per content block, all with the message's usage; keep the largest value seen per field.
    const u = apiUsage(message.usage);
    const prev = state.turnUsage.get(messageId)?.usage ?? ZERO;
    state.turnUsage.set(messageId, {
      model: str(message.model),
      usage: { input: Math.max(prev.input, u.input), output: Math.max(prev.output, u.output), cacheRead: Math.max(prev.cacheRead, u.cacheRead), cacheWrite: Math.max(prev.cacheWrite, u.cacheWrite) },
    });
  }
  if (!parent && message.usage) {
    const u: Loose = message.usage;
    state.contextTokens = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0);
    state.contextModel = str(message.model);
  }
  const out: HarnessEvent[] = [];
  for (const entry of assistantEntries(message, state.blockCounts, parent, str(m.timestamp))) {
    out.push({ type: "entry", entry });
    if (entry.kind === "tool" && entry.name === "TodoWrite") {
      const todos = todosFrom(entry.input);
      if (todos) out.push({ type: "todos", todos });
    }
  }
  return out;
}

// Background task notifications. When a background task (subagent, Bash) settles, the CLI emits a `system`
// `task_notification` message and injects a user-role message whose text is a `<task-notification>` XML block
// (task-id, tool-use-id, output-file, status, summary, result, usage…) for the model, sometimes beside
// `<system-reminder>` blocks. The user never typed either: both become one `system` entry whose id comes from the task
// id, so the stored conversation and the live stream give the same entry. Its text is the summary only: never the
// output file, tool use id or result.

export interface TaskNotice {
  taskId: string | null;
  toolUseId?: string | null;
  status: string | null;
  summary: string | null;
}

const NOTIFICATION_BLOCK = /<task-notification>([\s\S]*?)<\/task-notification>/g;
const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

const unescapeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function xmlChild(body: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
  const v = m ? unescapeXml(m[1]!).trim() : "";
  return v || null;
}

/** The text without `<system-reminder>` blocks, trimmed. */
export function stripSystemReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER_BLOCK, "").trim();
}

/**
 * The notifications in a user text block that is only `<task-notification>` blocks (and `<system-reminder>` blocks),
 * or null when it holds anything else (it's then the user's text, left as it is).
 */
export function parseTaskNotifications(text: string): TaskNotice[] | null {
  const rest = stripSystemReminders(text);
  if (!rest.startsWith("<task-notification>")) return null;
  const notices: TaskNotice[] = [];
  const leftover = rest.replace(NOTIFICATION_BLOCK, (_all, body: string) => {
    notices.push({ taskId: xmlChild(body, "task-id"), toolUseId: xmlChild(body, "tool-use-id"), status: xmlChild(body, "status"), summary: xmlChild(body, "summary") });
    return "";
  });
  return notices.length && !leftover.trim() ? notices : null;
}

const NOTICE_MAX = 200;

/** The short line shown for a notification: its summary, else its status. */
export function taskNoticeText(notice: TaskNotice): string {
  const summary = notice.summary?.replace(/\s+/g, " ").trim();
  if (summary) return summary.length > NOTICE_MAX ? `${summary.slice(0, NOTICE_MAX - 1)}…` : summary;
  return `Background task ${notice.status ?? "finished"}`;
}

/** The entry id of a notification: from its task id and status, else `<message uuid>:notice:<index>`. */
export function taskNoticeId(notice: TaskNotice, uuid: string, index: number): string {
  return notice.taskId ? `task:${notice.taskId}:${notice.status ?? "done"}` : `${uuid}:notice:${index}`;
}

export function taskNoticeEntry(notice: TaskNotice, id: string, at: string | null, parentToolUseId: string | null): TranscriptEntry {
  return { kind: "system", id, level: "info", text: taskNoticeText(notice), at, parentToolUseId };
}

/** The id of the `index`th injected part of a message: the message uuid when it's the only one. */
export function injectedId(uuid: string, index: number, count: number): string {
  return count === 1 ? uuid : `${uuid}:injected:${index}`;
}

export function injectedEntry(inj: Injected, id: string, at: string | null, parentToolUseId: string | null): TranscriptEntry {
  return { kind: "injected", id, source: inj.source, from: inj.from, text: inj.text, at, parentToolUseId };
}

/**
 * User messages from the SDK carry tool results (and subagent prompts, and background task notifications). Messages
 * the driver sent aren't echoed.
 */
function userMessage(m: Loose, sent: ReadonlySet<string>, state: MapState): HarnessEvent[] {
  if (m.isReplay || m.isSynthetic) return [];
  if (isInterruptMessage(m.message?.content)) return [];
  if (typeof m.uuid === "string" && sent.has(m.uuid)) return [];
  const parent = str(m.parent_tool_use_id);
  const content = m.message?.content;
  const out: HarnessEvent[] = [];
  const texts: string[] = [];
  const notices: TaskNotice[] = [];
  const injected: Injected[] = [];
  const addText = (text: string) => {
    const found = parseTaskNotifications(text);
    if (found) notices.push(...found);
    else if (text.trim() && !stripSystemReminders(text)) return;
    else {
      const inj = injectedMessage(m, text);
      if (inj) injected.push(inj);
      else texts.push(text);
    }
  };
  if (typeof content === "string") addText(content);
  else if (Array.isArray(content)) {
    for (const b of content as Loose[]) {
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") out.push({ type: "tool.result", toolUseId: b.tool_use_id, result: toToolResult(b, { toolUseResult: m.tool_use_result, meta: m.tool_result_meta }) });
      else if (b?.type === "text" && typeof b.text === "string") addText(b.text);
    }
  }
  // A message carrying a notification wasn't typed by the user: no reminders in what's left of it.
  if (notices.length) texts.splice(0, texts.length, ...texts.map(stripSystemReminders).filter(Boolean));
  const uuid = String(m.uuid ?? "user");
  notices.forEach((n, i) => {
    if (n.taskId) out.push(...taskEvents(state.tasks, { subtype: "task_notification", task_id: n.taskId, tool_use_id: n.toolUseId, status: n.status, summary: n.summary, run_id: m.origin?.runId, timestamp: m.timestamp }));
    else out.push({ type: "entry", entry: taskNoticeEntry(n, taskNoticeId(n, uuid, i), str(m.timestamp), parent) });
  });
  injected.forEach((inj, i) => {
    out.push({ type: "entry", entry: injectedEntry(inj, injectedId(uuid, i, injected.length), str(m.timestamp), parent) });
  });
  // A subagent's prompt arrives as a user text message nested under its Task call.
  if (parent && texts.length && typeof m.uuid === "string") {
    out.unshift({ type: "entry", entry: { kind: "user", id: m.uuid, text: texts.join("\n"), at: str(m.timestamp), parentToolUseId: parent } });
  }
  return out;
}

function resultMessage(state: MapState, m: Loose): HarnessEvent[] {
  const out: HarnessEvent[] = [];
  const modelUsage: Loose = m.modelUsage ?? {};
  const entries = Object.entries(modelUsage) as [string, Loose][];
  const base = state.usageBase;
  const nextBase = new Map<string, { usage: TokenUsage; costUsd: number | null }>();
  for (const [model, u] of entries) {
    const total = usageOf(u);
    const cost = typeof u.costUSD === "number" ? u.costUSD : null;
    nextBase.set(model, { usage: total, costUsd: cost });
    let own: TokenUsage;
    let ownCost: number | null;
    if (base) {
      const prev = base.get(model);
      own = minus(total, prev?.usage ?? ZERO);
      ownCost = cost === null ? null : Math.max(0, cost - (prev?.costUsd ?? 0));
    } else {
      // First report of a resumed/forked process: this turn's messages for the model (all of them when it's the
      // only model, in case the message names it differently).
      const msgs = [...state.turnUsage.values()].filter((t) => t.model === model || entries.length === 1);
      own = msgs.reduce((acc, t) => plus(acc, t.usage), ZERO);
      own = { input: Math.min(own.input, total.input), output: Math.min(own.output, total.output), cacheRead: Math.min(own.cacheRead, total.cacheRead), cacheWrite: Math.min(own.cacheWrite, total.cacheWrite) };
      ownCost = cost === null ? null : weight(total) > 0 ? (cost * weight(own)) / weight(total) : 0;
    }
    if (isZero(own) && !ownCost) continue;
    out.push({
      type: "usage",
      model,
      usage: own,
      cumulative: false,
      costUsd: ownCost,
      contextTokens: model === state.contextModel ? state.contextTokens : null,
    });
  }
  if (entries.length) state.usageBase = nextBase;
  state.turnUsage.clear();
  const error = isAbortResult(m) ? "interrupted" : resultError(m);
  out.push({ type: "turn.end", durationMs: Number(m.duration_ms ?? 0), ok: error === null, error });
  out.push(...setState(state, "idle"));
  // Message ids never span turns.
  state.blockCounts.clear();
  state.streaming.clear();
  return out;
}

/**
 * Maps one SDK message to events. `sent` holds the uuids of user messages the driver itself sent (and already showed).
 * Mutates `state`.
 */
export function mapMessage(state: MapState, message: SDKMessage | Loose, sent: ReadonlySet<string> = new Set()): HarnessEvent[] {
  const m = message as Loose;
  switch (m.type) {
    case "system":
      return systemMessage(state, m);
    case "stream_event":
      return streamEvent(state, m);
    case "assistant":
      return assistantMessage(state, m);
    case "user":
      return userMessage(m, sent, state);
    case "result":
      return resultMessage(state, m);
    case "rate_limit_event":
      return rateLimitNotice(m.rate_limit_info);
    case "conversation_reset":
      // Odin blocks /clear; other resets (e.g. leaving plan mode with a cleared context) still happen.
      return [{ type: "notice", level: "warning", text: "Claude started a fresh conversation; earlier messages are no longer in its context" }];
    default:
      return [];
  }
}
