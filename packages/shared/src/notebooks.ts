/**
 * A notebook is an ordinary .ipynb file in the project, addressed by a project-relative path; cells and outputs live
 * in that file. SQLite holds one kernel record per (root, path), where root is the project root or a session cwd plus execution receipts. The kernel process starts
 * lazily on first execute.
 */
export type KernelLocation = { kind: "native" } | { kind: "wsl"; distro: string };
export type KernelState = "stopped" | "starting" | "idle" | "busy" | "failed";
export interface NotebookKernel {
  id: string; project: string;
  /** Project-relative, forward slashes, ends in .ipynb. */
  path: string;
  /** Display name: the file basename. */
  name: string; cwd: string; interpreter: string;
  location: KernelLocation; state: KernelState; createdAt: string; updatedAt: string; error: string | null;
}
export type NotebookOutput =
  | { type: "stream"; name: "stdout" | "stderr"; text: string }
  | { type: "error"; name: string; message: string; traceback: string[] }
  | { type: "display"; data: Record<string, unknown>; metadata?: Record<string, unknown> };
export interface NotebookCell {
  id: string; kind: "code" | "markdown"; source: string; outputs: NotebookOutput[];
  executionCount: number | null;
  author: { kind: "human" } | { kind: "agent"; sessionId: string };
}
export interface NotebookSnapshot {
  kernel: NotebookKernel; revision: string; cells: NotebookCell[];
}
/** Open (or register) the notebook at a project-relative path. Does not start a kernel process. */
export interface OpenNotebookRequest {
  path: string;
  /** Resolve `path` against this session's cwd (same project) instead of the project root. */
  sessionId?: string;
  /** Write an empty nbformat-4 file when the path does not exist; otherwise a missing file is 404. */
  create?: boolean;
  interpreter?: string;
  location?: KernelLocation;
}
export interface NotebookEnvironment {
  kind: "venv" | "uv" | "poetry" | "conda" | "missing";
  interpreter: string | null;
  managedHostPython: string;
  needsSetup: boolean;
}
export type ExecutionState = "queued" | "running" | "completed" | "failed" | "interrupted";
export interface NotebookExecution {
  id: string; kernelId: string; cellId: string; sessionId: string | null; state: ExecutionState;
  startedAt: string | null; finishedAt: string | null; error: string | null;
}
export interface ExecuteCellRequest {
  cellId?: string; source?: string; revision: string; sessionId?: string;
}
export interface NotebookNotice {
  id: string; sessionId: string; kernelId: string; text: string; createdAt: string;
}
export interface NotebookVariable { name: string; type: string; preview: string; shape?: number[] }
export interface NotebookDataFrame {
  columns: { name: string; type: string }[];
  rows: unknown[][];
  total: number;
  offset: number;
  limit: number;
}
export interface DataFrameQuery { offset?: number; limit?: number; sort?: string; descending?: boolean }
/** JSON comm envelopes; binary buffers are bounded base64 strings at the HTTP/SSE boundary. */
export interface NotebookComm {
  type: "comm_open" | "comm_msg" | "comm_close";
  commId: string;
  targetName?: string;
  metadata?: Record<string, unknown>;
  data: Record<string, unknown>;
  buffers?: string[];
}
