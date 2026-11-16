// Maps a run's rows onto rail steps (components/Rail). The rail is generic; what a step says, and what it opens
// onto, is decided here. Pure, so it is testable without a DOM.
import type { RailStepView } from '@/components/Rail'
import type { ToolCallView } from '@/components/ToolCall'
import { terminalView } from '@/components/ToolCall/terminal'
import { toolMeta, toolPath, toolSummary } from '@/components/ToolCall/summary'
import { THINKING_VERBS, toolVerbs } from '@/components/ToolCall/verbs'
import { taskStatus } from './activity'
import { commandTaskView } from './sessionView'
import { formatWorked, type RunItem, type RunRow } from './steps'

/** What a step opens onto. */
export type StepBody =
  | { kind: 'call'; call: ToolCallView }
  | { kind: 'thinking'; text: string }
  | { kind: 'agent'; summary: string }

export interface RailRun {
  steps: RailStepView[]
  bodies: Map<string, StepBody>
  /** Top-level rows by step id, for artifacts and task actions. */
  rows: Map<string, RunRow>
}

interface Ctx {
  root: string | null | undefined
  times: Map<string, number>
  bodies: Map<string, StepBody>
}

const NOTE_LINES = 3
const NOTE_CHARS = 240

const tail = (text: string, lines: number) =>
  text
    .split(/\r\n|\n|\r/)
    .filter(l => l.trim() !== '')
    .slice(-lines)
    .join('\n')

/** The status word where the shape and verb alone would not say it; undefined for ordinary running/done. */
function statusWord(call: Pick<ToolCallView, 'status' | 'statusText'>): string | undefined {
  switch (call.status) {
    case 'failed':
      return 'failed'
    case 'awaiting':
      return 'needs approval'
    case 'cancelled':
      return call.statusText ?? 'cancelled'
    case 'idle':
      return call.statusText
    default:
      return undefined
  }
}

function duration(
  from: number | undefined | null,
  to: number | undefined | null,
): string | undefined {
  if (from === undefined || from === null || to === undefined || to === null) return undefined
  return to - from >= 1000 ? formatWorked(to - from) : undefined
}

function callStep(
  call: ToolCallView,
  ctx: Ctx,
  opts: {
    id?: string
    target?: string
    end?: number | null
    startedAt?: number | null
    done?: number | null
  } = {},
): RailStepView {
  const id = opts.id ?? call.id
  ctx.bodies.set(id, { kind: 'call', call })
  const terminal = terminalView(call)
  const path = toolPath(call)
  const target =
    opts.target ?? (terminal ? terminal.summary : path ? undefined : toolSummary(call, ctx.root))
  const isAgent = call.name === 'Agent' || call.name === 'Task'
  // an agent's own steps live in the preview pane (Open agent), not on the thread's rail
  const childCount = call.children?.length ?? 0
  const startedAt = opts.startedAt ?? ctx.times.get(id) ?? null
  const finished = call.status === 'ok' || call.status === 'failed' || call.status === 'cancelled'
  const meta =
    statusWord(call) ??
    (call.status === 'ok' ? toolMeta(call) : undefined) ??
    (isAgent && call.status === 'ok' && childCount
      ? `${childCount} ${childCount === 1 ? 'step' : 'steps'}`
      : undefined) ??
    (finished ? duration(startedAt, opts.done ?? opts.end) : undefined)
  const note =
    call.status === 'running' && terminal && call.result?.text
      ? tail(call.result.text, NOTE_LINES)
      : undefined
  return {
    id,
    kind: isAgent ? 'agent' : 'tool',
    status: call.status,
    verb: toolVerbs(call.name),
    ...(target ? { target } : {}),
    ...(path ? { path } : {}),
    ...(meta ? { meta } : {}),
    ...(call.status === 'running' && startedAt !== null ? { startedAt } : {}),
    ...(note ? { note } : {}),
  }
}

/** Rail steps for a run. `after` is when whatever followed the run happened, to time its last step. */
export function railRun(
  item: RunItem,
  opts: { root?: string | null; times: Map<string, number>; after?: number | null },
): RailRun {
  const ctx: Ctx = { root: opts.root, times: opts.times, bodies: new Map() }
  const rows = new Map<string, RunRow>()
  const steps = item.rows.map((row, i): RailStepView => {
    rows.set(row.id, row)
    // a step's duration is the gap to the next step, the closest thing the transcript says about when it ended
    const nextRow = item.rows[i + 1]
    const end = (nextRow ? opts.times.get(nextRow.id) : opts.after) ?? null
    switch (row.kind) {
      case 'tool':
        return callStep(row.call, ctx, { end })
      case 'thinking': {
        const running = !!row.streaming
        const text = row.entry.text
        if (text) ctx.bodies.set(row.id, { kind: 'thinking', text })
        const started = opts.times.get(row.id) ?? null
        const meta = running ? undefined : duration(started, end)
        return {
          id: row.id,
          kind: 'thinking',
          status: running ? 'running' : 'ok',
          verb: THINKING_VERBS,
          ...(meta ? { meta } : {}),
          ...(running && started !== null ? { startedAt: started } : {}),
          ...(running && text ? { note: text.slice(-NOTE_CHARS) } : {}),
          hasBody: !!text,
        }
      }
      case 'task': {
        const task = row.task
        const status = taskStatus(task.state)
        const startedAt = task.startedAt ? Date.parse(task.startedAt) : NaN
        const completedAt = task.completedAt ? Date.parse(task.completedAt) : NaN
        const done = Number.isNaN(completedAt) ? null : completedAt
        const started = Number.isNaN(startedAt) ? null : startedAt
        if (task.kind === 'command') {
          return callStep(commandTaskView(task), ctx, {
            id: row.id,
            target: task.label,
            startedAt: started,
            done,
            end: null,
          })
        }
        const call = commandTaskView(task)
        const meta = statusWord(call) ?? (status === 'ok' ? duration(started, done) : undefined)
        if (task.summary) ctx.bodies.set(row.id, { kind: 'agent', summary: task.summary })
        return {
          id: row.id,
          kind: 'agent',
          status,
          verb: toolVerbs('Agent'),
          target: task.label,
          ...(meta ? { meta } : {}),
          ...(status === 'running' && started !== null ? { startedAt: started } : {}),
          hasBody: !!task.summary,
        }
      }
    }
  })
  return { steps, bodies: ctx.bodies, rows }
}
