// The harness layer: what Odin needs from an agent runtime. Drivers: Claude Agent SDK and Codex app-server.
// Nothing outside src/harness/<id>/ may import an SDK's types: the
// rest of core and the web see only these interfaces and the events in @odin/shared/harness.
// Changing this file is a contract change. docs/contracts.md#harness.
import type { HarnessCapabilities, HarnessId, ModelInfo, PermissionAnswer, PermissionMode, TokenUsage, UserMessage } from "@odin/shared/api";
import type { HarnessEvent, TranscriptEntry, TaskActivity, TaskHistory } from "@odin/shared/harness";

/** A subagent definition passed at start (a library agent), without writing it to the repo. */
export interface AgentSpec {
  description: string;
  /** System prompt (the agent file's body). */
  prompt: string;
  tools?: string[];
  model?: string;
}

/** An MCP server passed at start. Same shapes as `.mcp.json`. */
export type McpServerStart =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> };

/**
 * A tool Odin itself serves to the session (in-process, e.g. `post_artifact`). Harness-neutral: the driver exposes
 * it however its harness does (Claude: an in-process MCP server named ODIN_MCP_SERVER, tools `mcp__<server>__<name>`,
 * server defaulting to `odin`).
 */
export type HostToolContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: "image/png" | "image/jpeg"; data: string };
export interface HostToolResult {
  text: string;
  content?: HostToolContent[];
  isError?: boolean;
}

export interface HostTool {
  name: string;
  /** MCP server the tool is grouped under. Default ODIN_MCP_SERVER. */
  server?: string;
  description: string;
  /** Flat parameter list; enough for Odin's own tools. */
  params: Record<string, { type: "string" | "number" | "boolean"; description: string; optional?: boolean }>;
  /** Returns text for the model; throw or return `isError` to report a failure to it. */
  handler(input: Record<string, unknown>): Promise<HostToolResult>;
  /** Core authorizes the call before entering the handler, independently of driver policy. */
  effect?: "execute" | "edit";
}

export interface StartOptions {
  runtimeOptions?: import("@odin/shared/api").RuntimeOptions;
  cwd: string;
  /**
   * The stable Odin id for a new session (or fork). Drivers map to native ids when needed. Odin creates it so the record
   * exists before the harness answers. Omitted on a plain resume (the id is `resume`).
   */
  sessionId?: string;
  /** Resume this harness session. With `fork: true`, the history is copied into `sessionId` instead. */
  resume?: string;
  fork?: boolean;
  /** First user message; omitted on a resume that just reattaches. */
  prompt?: UserMessage;
  title?: string;
  model?: string;
  effort?: import("@odin/shared/api").Effort | null;
  permissionMode?: PermissionMode;
  /** Additional shared instructions; appended to the native default agent's instructions. */
  instructions?: string;
  /** Subagents available for delegation. The main thread always uses the native default agent. */
  agents?: Record<string, AgentSpec>;
  mcpServers?: Record<string, McpServerStart>;
  hostTools?: HostTool[];
  /** Extra directories the session may access. */
  additionalDirectories?: string[];
}

/** A live session. Events end with exactly one `exit`. */
export interface SessionHandle {
  setRuntimeOptions?(options: import("@odin/shared/api").RuntimeOptions): Promise<void>;
  nativeAction?(action: import("@odin/shared/api").NativeSessionAction): Promise<import("@odin/shared/api").NativeSessionState>;
  readonly sessionId: string;
  readonly events: AsyncIterable<HarnessEvent>;
  /**
   * Accept one service-dispatched message at an idle boundary. The durable service outbox owns queued work;
   * callers must not use a driver's private input queue for durable delivery. A synchronous throw means not
   * accepted. The following turn.end is the delivery boundary; failure/exit leaves an uncertain receipt.
   */
  send(message: UserMessage): void;
  /** Answer an open `permission.request`. Unknown or already-answered ids are ignored. */
  answer(requestId: string, answer: PermissionAnswer): void;
  /** Stop the current turn; the session stays open (state → idle). */
  interrupt(): Promise<void>;
  setModel(model: string): Promise<void>;
  setEffort?(effort: import("@odin/shared/api").Effort | null): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /** End the handle (the session stays resumable). Open prompts are cancelled. Emits `exit` `closed`. */
  close(): Promise<void>;
}

/** What the harness knows about a stored session (including ones Odin didn't start). */
export interface HarnessSessionInfo {
  sessionId: string;
  title: string;
  firstPrompt: string | null;
  cwd: string | null;
  gitBranch: string | null;
  createdAt: string | null;
  updatedAt: string;
}

/** Measurements recovered from native history, without conversation content or credentials. */
export type HarnessMeasurement = { id: string; at: string } & (
  | { kind: "usage"; data: TokenUsage & { model: string; cumulative: boolean; costUsd: number | null; contextTokens: number | null; contextWindow?: number | null } }
  | { kind: "turn"; data: { durationMs: number | null; ok: boolean } }
  | { kind: "tool"; data: { name: string; ok: boolean } }
  | { kind: "activity"; data: Record<string, never> }
);

export interface Harness {
  close?(): Promise<void>;
  nativeCatalog?(cwd: string): Promise<import("@odin/shared/api").NativeCatalog>;
  nativeState?(sessionId: string, cwd: string): Promise<import("@odin/shared/api").NativeSessionState>;
  readonly capabilities?: HarnessCapabilities;
  readonly id: HarnessId;
  readonly name: string;
  /** Whether it can run here, with a reason when not. Never reads or returns credentials. */
  check(): Promise<{ available: boolean; note: string | null }>;
  start(options: StartOptions): SessionHandle;
  /** Stored sessions for a project directory (and its git worktrees), newest first. */
  list(projectPath: string): Promise<HarnessSessionInfo[]>;
  /** One stored session, or null. */
  info(sessionId: string, projectPath?: string): Promise<HarnessSessionInfo | null>;
  /** The stored conversation, mapped to transcript entries (tool results attached to their calls). */
  messages(sessionId: string, projectPath?: string): Promise<TranscriptEntry[]>;
  /** Read-only child history; must validate the child belongs to this parent. Never starts/resumes a turn. */
  taskMessages?(sessionId: string, task: TaskActivity, projectPath?: string): Promise<TaskHistory>;
  /** Complete native measurements for an imported session; null means unavailable, not an empty history. */
  measurements?(sessionId: string, projectPath?: string): Promise<HarnessMeasurement[] | null>;
  rename(sessionId: string, title: string, projectPath?: string): Promise<void>;
  /** Copy a stored session into a new one without running it. Returns the new id. */
  fork(sessionId: string, projectPath?: string): Promise<string>;
  /**
   * Like `fork`, but the copy ends just before the user message `messageId` (an id from `messages()`). Throws when the
   * message is not a user message of that session. Present only when `capabilities.checkpoints.forkAt` is true.
   */
  forkAt?(sessionId: string, messageId: string, projectPath?: string): Promise<string>;
  delete(sessionId: string, projectPath?: string): Promise<void>;
  models(): Promise<ModelInfo[]>;
}

/** The registered drivers, keyed by id. Deps carries this; tests pass `{ claude: fakeHarness() }`. */
export type Harnesses = Record<string, Harness>;
