// One step on the rail. Generic: screens map their rows onto it, the rail knows nothing about harnesses.
import type { Status } from '@/styles/status'

export type RailKind = 'tool' | 'thinking' | 'agent'

export interface RailStepView {
  id: string
  kind: RailKind
  status: Extract<Status, 'running' | 'awaiting' | 'ok' | 'failed' | 'cancelled' | 'idle'>
  verb: { live: string; done: string }
  /** One line: a path, query or command. */
  target?: string
  /** A file path, shown with IuFilePath (relative to the rail's `root`) instead of `target`. */
  path?: string
  /** The result or a status word; elapsed time is supplied while the step runs and has a `startedAt`. */
  meta?: string
  /** Ms epoch, for the elapsed time. */
  startedAt?: number
  /** Live tail under a running step: thought text or the last output lines. */
  note?: string
  children?: RailStepView[]
  /** False when there is nothing to expand besides `children`. Default true. */
  hasBody?: boolean
}
