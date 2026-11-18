// Mock data for the subagent-activity mockups. A timeline of five subagents, evaluated at any second `t`,
// so a still can be taken at a chosen moment and a GIF by stepping `t`.
export type SubState = 'pending' | 'running' | 'waiting' | 'done' | 'failed'

export interface Sub {
  id: string
  name: string
  task: string
  state: SubState
  /** 0..1 share of the work finished (frozen while waiting) */
  progress: number
  /** planned tool calls, in order */
  tools: string[]
  /** index of the tool call in flight (running/waiting) or the last one made (done/failed) */
  step: number
  /** one short line: the current tool, what it waits for, or the result */
  note: string
}

interface Spec {
  id: string
  name: string
  task: string
  tools: string[]
  start: number
  /** seconds of running time */
  dur: number
  /** [from, to] seconds after start the agent waits on the person */
  pause?: [number, number]
  end: 'done' | 'failed'
  waitNote?: string
  endNote: string
}

export const LOOP = 34

const specs: Spec[] = [
  { id: 'a1', name: 'explorer', task: 'Map the auth middleware', tools: ['Glob', 'Search', 'Read', 'Read', 'Search', 'Read'], start: 0, dur: 9, end: 'done', endNote: '14 call sites found' },
  { id: 'a2', name: 'test-runner', task: 'Run the core test suite', tools: ['Bash', 'Read', 'Bash', 'Test'], start: 2, dur: 14, end: 'failed', endNote: '3 tests failed' },
  { id: 'a3', name: 'reviewer', task: 'Review the open diff', tools: ['Read', 'Read', 'Search', 'Read', 'Think'], start: 1, dur: 12, pause: [5, 12], end: 'done', waitNote: 'Wants to run git fetch', endNote: 'No blockers found' },
  { id: 'a4', name: 'docs', task: 'Draft the changelog entry', tools: ['Read', 'Edit', 'Write'], start: 9, dur: 8, end: 'done', endNote: 'Wrote changes/feat-x.md' },
  { id: 'a5', name: 'migrator', task: 'Check the db schema', tools: ['Read', 'Search', 'Bash', 'Edit', 'Test'], start: 12, dur: 13, end: 'done', endNote: 'Schema is current' },
]

export function agentsAt(time: number): Sub[] {
  const t = ((time % LOOP) + LOOP) % LOOP
  return specs.map((s) => {
    const age = t - s.start
    const base = { id: s.id, name: s.name, task: s.task, tools: s.tools }
    if (age < 0) return { ...base, state: 'pending', progress: 0, step: 0, note: 'Not started' }
    let run = age
    let waiting = false
    if (s.pause) {
      const [a, b] = s.pause
      if (age >= a && age < b) {
        run = a
        waiting = true
      } else if (age >= b) run = age - (b - a)
    }
    const progress = Math.min(1, run / s.dur)
    const last = s.tools.length - 1
    if (progress >= 1) return { ...base, state: s.end, progress: 1, step: last, note: s.endNote }
    const step = Math.min(last, Math.floor(progress * s.tools.length))
    if (waiting) return { ...base, state: 'waiting', progress, step, note: s.waitNote ?? 'Waiting on you' }
    return { ...base, state: 'running', progress, step, note: s.tools[step] }
  })
}

export const stateWord: Record<SubState, string> = {
  pending: 'Queued',
  running: 'Working',
  waiting: 'Waiting on you',
  done: 'Returned',
  failed: 'Failed',
}

export const stateColor: Record<SubState, string> = {
  pending: 'var(--iu-text-disabled)',
  running: 'var(--iu-info)',
  waiting: 'var(--iu-warning)',
  done: 'var(--iu-positive)',
  failed: 'var(--iu-danger)',
}

/** Hue slot (0-5) for an agent, matching the shield / thread colours used elsewhere in the app. */
export const hueOf = (id: string) => Number(id.slice(1)) % 6

export function summary(agents: Sub[]): string {
  const count = (s: SubState) => agents.filter((a) => a.state === s).length
  return `${count('running')} working, ${count('waiting')} waiting on you, ${count('done')} returned, ${count('failed')} failed`
}
