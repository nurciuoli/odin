// The ingest contract: POST /api/ingest. Sessions started outside Odin (`claude` in a terminal) report through the
// Claude Code hook adapter as these events. Sessions Odin runs are measured from the harness stream instead.
// See docs/contracts.md#ingest.
import type { HarnessId, TokenUsage } from "./api.ts";

export const INGEST_HEADER = "authorization"; // "Bearer <ODIN_INGEST_TOKEN>"
export const INGEST_MAX_BATCH = 500;

export type IngestKind = "session.started" | "session.ended" | "turn" | "tool" | "usage" | "message" | "error";

interface IngestBase<K extends IngestKind, D> {
  /** Producer-generated, globally unique. Re-sending the same id is a no-op. */
  id: string;
  ts: string;
  harness: HarnessId;
  /** The harness's session id: the Odin session id. */
  session: string;
  /** Project name, when the producer knows it. Otherwise core resolves it from cwd. */
  project?: string;
  cwd?: string;
  branch?: string;
  /** Main-thread agent or subagent type, when known. */
  agent?: string;
  kind: K;
  data: D;
}

export type SessionStartedEvent = IngestBase<"session.started", {
  model?: string;
  title?: string;
  /** startup | resume | clear | compact (Claude Code's SessionStart source). */
  source?: string;
}>;

export type SessionEndedEvent = IngestBase<"session.ended", {
  outcome: "completed" | "failed";
  error?: string;
}>;

/** One model turn: user prompt → final reply. */
export type TurnEvent = IngestBase<"turn", {
  index: number;
  durationMs: number;
  model?: string;
}>;

/** A tool call. Never carries file contents or command output, only names and paths. */
export type ToolEvent = IngestBase<"tool", {
  name: string;
  /** e.g. a file path, a command's first words. Truncated to 200 chars by core. */
  target?: string;
  ok: boolean;
  durationMs?: number;
}>;

/** Token usage. `cumulative: true` replaces earlier usage for this session+model. */
export type UsageEvent = IngestBase<"usage", TokenUsage & {
  model: string;
  cumulative?: boolean;
}>;

export type MessageEvent = IngestBase<"message", { text: string }>;

export type ErrorEvent = IngestBase<"error", { message: string }>;

export type IngestEvent =
  | SessionStartedEvent
  | SessionEndedEvent
  | TurnEvent
  | ToolEvent
  | UsageEvent
  | MessageEvent
  | ErrorEvent;

export interface IngestResponse {
  accepted: number;
  duplicates: number;
  /** Per-event problems by id; those events were dropped. */
  rejected: { id: string; error: string }[];
  /** Session ids the accepted events landed in. */
  sessionIds: string[];
}

export const INGEST_KINDS: IngestKind[] = ["session.started", "session.ended", "turn", "tool", "usage", "message", "error"];
