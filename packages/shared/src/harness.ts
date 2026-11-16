// The harness-neutral conversation model. Drivers (core/src/harness/<id>/) translate their SDK's messages into these;
// everything above the driver (sessions service, routes, SSE, web) sees only these types. docs/contracts.md#harness.
import type { PermissionMode, TokenUsage, Todo } from "./api.ts";

/** Tool results are cut to this many characters for display (the harness keeps the full text). */
export const TOOL_RESULT_MAX_CHARS = 20_000;

export interface ToolResult {
  ok: boolean;
  /** Text content, truncated to TOOL_RESULT_MAX_CHARS. Images become "[image]". */
  text: string;
  truncated: boolean;
  /**
   * Set when the user, not the tool, ended the call: "denied" (refused before it ran) or "interrupted" (stopped
   * while running or by an interrupt). `ok` stays false for both; `text` is a short label, not model-directed prose.
   */
  status?: "denied" | "interrupted";
}

export type TaskState = "running" | "completed" | "failed" | "stopped" | "unknown";

/** One native task run. Null times mean unavailable, never an inferred observation time. */
export interface TaskActivity {
  taskId: string;
  runId: string | null;
  kind: "agent" | "command";
  label: string;
  state: TaskState;
  toolUseId: string | null;
  parentToolUseId: string | null;
  childSessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Local observation time, distinct from native lifecycle timestamps. */
  observedAt: string | null;
  summary?: string;
  output?: ToolResult;
}

/** Collision-free identity shared by history, live updates and preview selection. */
export function taskKey(task: Pick<TaskActivity, "taskId" | "runId">): string {
  return `task:${JSON.stringify([task.taskId, task.runId])}`;
}

export type TaskHistory =
  | { status: "available"; transcript: TranscriptEntry[] }
  | { status: "unavailable"; reason: string };

/**
 * One displayable unit of a conversation. History (`Harness.messages`) and live events produce the same entries,
 * so the Session screen renders both the same way. `id` is stable: the harness message uuid, or the tool_use id.
 * `parentToolUseId` nests subagent activity under the Agent/Task tool call that spawned it.
 */
export type TranscriptEntry =
  | { kind: "task"; id: string; task: TaskActivity; at: string | null; parentToolUseId: string | null }
  | { kind: "user"; id: string; text: string; attachments?: { name: string; mediaType: string }[]; at: string | null; parentToolUseId: string | null }
  | { kind: "assistant"; id: string; text: string; model: string | null; at: string | null; parentToolUseId: string | null }
  | { kind: "thinking"; id: string; text: string; at: string | null; parentToolUseId: string | null }
  | {
      kind: "tool";
      /** The tool_use id. */
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** Absent until the result arrives. */
      result?: ToolResult;
      at: string | null;
      parentToolUseId: string | null;
    }
  | { kind: "system"; id: string; level: "info" | "warning" | "error"; text: string; at: string | null; parentToolUseId: string | null }
  | {
      /**
       * A user-role message the harness put into the conversation that nobody typed: a subagent's or another
       * session's message, a channel message, a notification, a scheduled wakeup. Never rendered as the user's turn.
       */
      kind: "injected";
      id: string;
      source: InjectedSource;
      /** Who sent it (agent or session name, channel server), when known. */
      from: string | null;
      /** The message body with its wrapper removed. */
      text: string;
      at: string | null;
      parentToolUseId: string | null;
    };

/**
 * Where an injected message came from: agent = a subagent or teammate of this session (a hand-back, a report);
 * peer = another session; channel = an MCP channel; task = a background task notification; scheduled = a scheduled
 * wakeup or loop prompt; system = any other harness notice.
 */
export type InjectedSource = "agent" | "peer" | "channel" | "task" | "scheduled" | "system";

export type TranscriptKind = TranscriptEntry["kind"];

/**
 * A prompt the harness raised and is blocked on. `kind`: tool = a permission check; plan = ExitPlanMode (input.plan
 * holds the plan; allow = approve it); question = AskUserQuestion (input.questions; answer by allowing with
 * `updatedInput` carrying the answers).
 */
export interface PermissionRequest {
  /** Unique per prompt; the key for answering. */
  id: string;
  sessionId: string;
  kind: "tool" | "plan" | "question";
  toolName: string;
  toolUseId: string | null;
  input: Record<string, unknown>;
  /** Harness-written sentence, e.g. "Claude wants to write hello.txt". Display as text, never as HTML. */
  title: string | null;
  description: string | null;
  /** False when the harness says this prompt must not offer an "always allow" rule. */
  canAlwaysAllow: boolean;
  /** Open on the deny option; no one-key approve. */
  defaultToDeny: boolean;
  createdAt: string;
}

/**
 * A slash command the composer offers. Drivers report the harness's own commands (built-in, user/project/plugin, its
 * skills) and Odin library skills; the web adds Odin's own (`source: "odin"`), which it runs itself.
 */
export interface SlashCommand {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** Free-text argument hint, e.g. "<file>"; empty when the command takes none. */
  argumentHint: string;
  /** Other names that run this command. */
  aliases?: string[];
  /** builtin = the harness's own; custom = user, project, plugin or MCP; library = a Odin library skill; odin = handled by Odin. */
  source: "builtin" | "custom" | "library" | "odin";
  /**
   * Argument forms the composer offers as a second step after the command is chosen. `insert` follows `/name `;
   * when it ends with a space (or is empty) the user types the rest, guided by `hint`.
   */
  choices?: { label: string; insert: string; hint?: string }[];
}

/**
 * The common event stream of a live session. Ordering: `init` first, then any mix, with `turn.end` closing each turn.
 * Deltas are optional (a driver may send only whole `entry` events); a whole entry replaces any deltas with its id.
 */
export type HarnessEvent =
  /** Full normalized task snapshot, reconciled by native task/run identity. */
  | { type: "task"; task: TaskActivity }
  /** The session exists in the harness (new, resumed or forked). */
  | { type: "init"; sessionId: string; model: string | null; permissionMode: PermissionMode | null; cwd: string; tools: string[]; slashCommands: SlashCommand[]; agents: string[] }
  /** The harness's command list changed mid-session; replaces the one from `init`. */
  | { type: "commands"; slashCommands: SlashCommand[] }
  | { type: "state"; state: "running" | "idle" | "waiting" }
  /** Streaming text for an assistant or thinking entry that isn't complete yet. */
  | { type: "delta"; entryId: string; kind: "assistant" | "thinking"; text: string; parentToolUseId: string | null;
      /** UTF-16 text length before this delta; core adds it so REST/SSE overlap is idempotent. */
      offset?: number }
  /** A complete entry (new, or replacing the partial one with the same id). */
  | { type: "entry"; entry: TranscriptEntry }
  | { type: "tool.result"; toolUseId: string; result: ToolResult }
  | { type: "permission.request"; request: PermissionRequest }
  /** A prompt was answered (by the user, or withdrawn by the harness). */
  | { type: "permission.resolved"; requestId: string; behavior: "allow" | "deny" | "cancelled" }
  | { type: "todos"; todos: Todo[] }
  /**
   * Token usage. `cumulative: false` = this call's usage (add it); `true` = the session total for that model so far
   * (replace). `costUsd` is the harness's own figure for the same span when it reports one.
   */
  | { type: "usage"; model: string; usage: TokenUsage; cumulative: boolean; costUsd: number | null; contextTokens: number | null; contextWindow?: number | null }
  | { type: "turn.end"; durationMs: number; ok: boolean; error: string | null }
  | { type: "model"; model: string }
  | { type: "permission.mode"; mode: PermissionMode }
  | { type: "notice"; level: "info" | "warning" | "error"; text: string }
  /** The handle is finished: no more events. `failed` with an error when the harness died. */
  | { type: "exit"; outcome: "closed" | "failed"; error: string | null };

export type HarnessEventType = HarnessEvent["type"];
