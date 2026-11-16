// SSE: GET /api/events. Each frame is `event: <type>\ndata: <json>\n\n`. Clients refetch REST state on (re)connect.
import type { Artifact, Installation, MessageQueue, Session, SyncStatus } from "./api.ts";
import type { HarnessEvent } from "./harness.ts";

export const HEARTBEAT_MS = 20_000;
/** The client reconnects if nothing (not even a heartbeat) arrives for this long. */
export const STALE_MS = 45_000;

export type ServerEvent =
  | { type: "notebook.comm"; kernelId: string; message: import("./notebooks.ts").NotebookComm }
  | { type: "notebook.updated"; kernelId: string; project: string; revision: string }
  | { type: "notebook.execution"; execution: import("./notebooks.ts").NotebookExecution }
  | { type: "notebook.output"; kernelId: string; executionId: string; cellId: string; output: import("./notebooks.ts").NotebookOutput }
  | { type: "heartbeat"; at: string }
  /** Settings, git state or agents changed: refetch the project. */
  | { type: "project.updated"; project: string }
  | { type: "project.removed"; project: string }
  /** The session record changed (state, title, tags, metrics, pull…). Carries the full record. */
  | { type: "session.updated"; session: Session }
  | { type: "session.removed"; sessionId: string }
  | { type: "session.queue"; sessionId: string; queue: MessageQueue }
  /**
   * A live harness event for one session (streaming text, tool calls, prompts, usage). Only sent while someone could
   * be watching; the record-level effects also arrive as `session.updated`.
   */
  | { type: "session.event"; sessionId: string; event: HarnessEvent }
  | { type: "artifact.updated"; sessionId: string; artifact: Artifact }
  | { type: "library.updated"; kind: string; id: string }
  | { type: "install.updated"; installation: Installation }
  | { type: "sync.status"; project: string; sync: SyncStatus }
  /** Something worth a toast (a sync conflict, a failed background step). */
  | { type: "notice"; level: "info" | "warning" | "error"; text: string; project?: string };

export type ServerEventType = ServerEvent["type"];
