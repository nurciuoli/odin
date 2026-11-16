// status.ts — the one status vocabulary every component speaks.
//
// Before this, AgentTrace said ok/degraded/failed, Timeline said done/warning,
// and the session rail said done/warn/fail/active. Components now take a
// `Status` and derive colour, label and motion from here, so a "running" dot,
// badge, trace node and timeline marker always agree.

export type Status =
  | 'idle' // nothing has happened yet / informational
  | 'queued' // scheduled, not started
  | 'running' // in progress — the only animated state
  | 'awaiting' // paused on a human (approval, input)
  | 'ok' // finished successfully
  | 'warning' // finished or continuing, degraded
  | 'failed' // finished unsuccessfully
  | 'cancelled' // stopped by someone

export type Intent = 'neutral' | 'accent' | 'info' | 'positive' | 'warning' | 'danger'

export const statusIntent: Record<Status, Intent> = {
  idle: 'neutral',
  queued: 'neutral',
  // tempo carries "running" (a quick, even pulse), so its colour stays neutral; amber is kept for the one
  // state that needs the user
  running: 'neutral',
  awaiting: 'warning',
  ok: 'positive',
  warning: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
}

export const statusLabel: Record<Status, string> = {
  idle: 'idle',
  queued: 'queued',
  running: 'running',
  awaiting: 'awaiting',
  ok: 'done',
  warning: 'warning',
  failed: 'failed',
  cancelled: 'cancelled',
}

/** the ink colour for a status, as a CSS value */
export const statusColor: Record<Status, string> = {
  idle: 'var(--iu-text-muted)',
  queued: 'var(--iu-border-strong)',
  running: 'var(--iu-text-2)',
  awaiting: 'var(--iu-warning)',
  ok: 'var(--iu-positive)',
  warning: 'var(--iu-warning)',
  failed: 'var(--iu-danger)',
  cancelled: 'var(--iu-text-disabled)',
}

/** severity order for rolling a group up to its worst child */
export const statusRank: Status[] = [
  'idle',
  'cancelled',
  'queued',
  'ok',
  'warning',
  'running',
  'awaiting',
  'failed',
]

/** sort comparator: worst first (failed, awaiting, running, …, idle) */
export function compareStatus(a: Status, b: Status): number {
  return statusRank.indexOf(b) - statusRank.indexOf(a)
}

export function worstStatus(list: Status[]): Status {
  return list.reduce(
    (a, b) => (statusRank.indexOf(b) > statusRank.indexOf(a) ? b : a),
    'idle' as Status,
  )
}
