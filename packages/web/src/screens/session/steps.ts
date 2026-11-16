// A run of work in the thread: every consecutive thinking, tool and task row between two pieces of assistant text (or
// a user turn) is one run, drawn as one rail (components/Rail). Pure, so the rules are testable without a DOM.
import type { TranscriptEntry } from '@odin/shared/harness'
import type { Status } from '@/styles/status'
import { taskStatus } from './activity'
import type { Row } from './sessionView'

export type RunRow = Extract<Row, { kind: 'tool' | 'thinking' | 'task' }>

export interface RunItem {
  kind: 'run'
  /** The first row's id: stable while the run grows, so an open or closed summary stays that way. */
  id: string
  head: boolean
  rows: RunRow[]
  /** From the first step to whatever followed the run (or its last step); null without timestamps. */
  durationMs: number | null
}

export type ThreadItem = Row | RunItem

const inRun = (r: Row): r is RunRow =>
  r.kind === 'tool' || r.kind === 'thinking' || r.kind === 'task'

/** When each entry happened, from the transcript. */
export function entryTimes(entries: TranscriptEntry[]): Map<string, number> {
  const times = new Map<string, number>()
  for (const e of entries) {
    const t = e.at ? Date.parse(e.at) : NaN
    if (!Number.isNaN(t)) times.set(e.id, t)
  }
  return times
}

export function foldRuns(rows: Row[], entries: TranscriptEntry[]): ThreadItem[] {
  const times = entryTimes(entries)
  const timeOf = (row: Row) => times.get(row.id) ?? null
  const out: ThreadItem[] = []
  let i = 0
  while (i < rows.length) {
    const row = rows[i]!
    if (!inRun(row)) {
      out.push(row)
      i++
      continue
    }
    let j = i
    while (j < rows.length && inRun(rows[j]!)) j++
    const run = rows.slice(i, j) as RunRow[]
    const start = timeOf(run[0]!)
    const after = j < rows.length ? timeOf(rows[j]!) : null
    const end = after ?? timeOf(run[run.length - 1]!)
    out.push({
      kind: 'run',
      id: `steps-${run[0]!.id}`,
      head: run[0]!.head,
      rows: run,
      durationMs: start !== null && end !== null && end >= start ? end - start : null,
    })
    i = j
  }
  return out
}

/** "14s", "2m 14s", "1h 5m". */
export function formatWorked(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function rowStatus(row: RunRow): Status {
  switch (row.kind) {
    case 'tool':
      return row.call.status
    case 'thinking':
      return row.streaming ? 'running' : 'ok'
    case 'task':
      return taskStatus(row.task.state)
  }
}

export function isAgentRow(row: RunRow): boolean {
  if (row.kind === 'task') return row.task.kind === 'agent'
  return row.kind === 'tool' && (row.call.name === 'Agent' || row.call.name === 'Task')
}

/** Whether any step of the run is still running. */
export function runRunning(item: RunItem): boolean {
  return item.rows.some(r => rowStatus(r) === 'running')
}

/** A foreground step is running: the step itself says what is happening, so there is no working line. */
export function runBusy(item: RunItem): boolean {
  return item.rows.some(r => rowStatus(r) === 'running' && !isAgentRow(r))
}

/** Subagents out right now, anywhere on the thread: the dots that peel off the working flock. */
export function runningAgents(rows: Row[]): number {
  return rows.filter(r => inRun(r) && isAgentRow(r) && rowStatus(r) === 'running').length
}

/**
 * What the run's flock is doing: flying while the run is the live end of the thread, scattered once a step failed,
 * down otherwise. Null while a step waits on the user: the run has not ended and nothing is flying.
 */
export function runFlock(
  item: RunItem,
  opts: { live: boolean },
): 'working' | 'landed' | 'failed' | null {
  if (opts.live) return 'working'
  const statuses = item.rows.map(rowStatus)
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('awaiting')) return null
  return 'landed'
}

/** The summary line: "Worked for 15s · 7 steps · 1 agent". Time, and the agent count, only when known. */
export function runLabel(item: RunItem): string {
  const agents = item.rows.filter(isAgentRow).length
  const parts = [
    item.durationMs !== null && item.durationMs >= 1000
      ? `Worked for ${formatWorked(item.durationMs)}`
      : 'Worked',
    ...(agents ? [`${agents} ${agents === 1 ? 'agent' : 'agents'}`] : []),
  ]
  return parts.join(' · ')
}

/** A step that keeps the run open: it failed, waits on the user, or holds an artifact card. */
function blocksFold(row: RunRow): boolean {
  const status = rowStatus(row)
  return status === 'failed' || status === 'awaiting' || (row.kind === 'tool' && !!row.artifact)
}

/**
 * Whether the run shows folded. The user's toggle wins; otherwise a run is open while it is the live end of the thread
 * and folds once something follows it, unless a step failed, waits for approval or holds an artifact card. A step that
 * is still running once something follows it is a background task and does not hold the run open. A single step has
 * nothing to fold.
 */
export function runFolded(
  item: RunItem,
  opts: { live: boolean; override?: boolean | undefined },
): boolean {
  if (item.rows.length < 2) return false
  if (opts.override !== undefined) return opts.override
  if (opts.live) return false
  return !item.rows.some(blocksFold)
}
