// One tool call as the transcript shows it. Generic: screens map their harness's entries onto it.
import type { Status } from '@/styles/status'

export interface ToolCallView {
  id: string
  /** Tool name as the harness reports it, e.g. "Bash", "Edit", "mcp__odin__post_artifact". */
  name: string
  input: Record<string, unknown>
  /** running (no result yet), awaiting (a prompt is open for it), ok, failed. */
  status: Extract<Status, 'running' | 'awaiting' | 'ok' | 'failed' | 'cancelled' | 'idle'>
  /** Explicit wording for a neutral state such as unavailable task liveness. */
  statusText?: string
  result?: { text: string; truncated?: boolean }
  /** Nested calls (a subagent's work under its Agent/Task call). */
  children?: ToolCallView[]
}
