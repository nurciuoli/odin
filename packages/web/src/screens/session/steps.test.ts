// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@odin/shared/harness'
import { buildRows } from './sessionView'
import {
  foldRuns,
  formatWorked,
  runBusy,
  runFlock,
  runFolded,
  runLabel,
  runningAgents,
  type RunItem,
} from './steps'

const T0 = Date.parse('2026-11-12T12:00:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

const tool = (id: string, s: number, o: Partial<Extract<TranscriptEntry, { kind: 'tool' }>> = {}) =>
  ({
    kind: 'tool',
    id,
    name: 'Read',
    input: { file_path: `${id}.ts` },
    result: { ok: true, text: 'ok', truncated: false },
    at: at(s),
    parentToolUseId: null,
    ...o,
  }) as TranscriptEntry
const text = (id: string, s: number): TranscriptEntry => ({
  kind: 'assistant',
  id,
  text: id,
  model: null,
  at: at(s),
  parentToolUseId: null,
})
const thought = (id: string, s: number): TranscriptEntry => ({
  kind: 'thinking',
  id,
  text: 'hmm',
  at: at(s),
  parentToolUseId: null,
})
const artifact = (id: string, s: number) =>
  tool(id, s, {
    name: 'mcp__odin__post_artifact',
    input: { title: 'Layout' },
    result: { ok: true, text: 'Posted artifact 1 v1', truncated: false },
  })

const fold = (entries: TranscriptEntry[], running = false) =>
  foldRuns(buildRows(entries, { pending: [], streaming: [], running, artifacts: [] }), entries)
const runs = (entries: TranscriptEntry[]) =>
  fold(entries).filter((i): i is RunItem => i.kind === 'run')

const userStopped = (id: string, s: number, status: 'denied' | 'interrupted') =>
  tool(id, s, {
    result: {
      ok: false,
      status,
      text: status === 'denied' ? 'Denied' : 'Stopped by you',
      truncated: false,
    },
  })

describe('user-refused tool results', () => {
  const entries = [
    text('a', 0),
    userStopped('d', 1, 'denied'),
    userStopped('i', 2, 'interrupted'),
    text('b', 3),
  ]
  const rows = () =>
    buildRows(entries, { pending: [], streaming: [], running: false, artifacts: [] }).flatMap(r =>
      r.kind === 'tool' ? [r] : [],
    )

  it('maps to a neutral cancelled step with Denied / Stopped wording and keeps the text', () => {
    const [d, i] = rows()
    expect(d!.call).toMatchObject({
      status: 'cancelled',
      statusText: 'Denied',
      result: { text: 'Denied' },
    })
    expect(i!.call).toMatchObject({ status: 'cancelled', statusText: 'Stopped' })
  })

  it('neither flies as failed nor keeps the run unfolded', () => {
    const [run] = runs(entries)
    expect(runFlock(run!, { live: false })).toBe('landed')
    expect(runFolded(run!, { live: false })).toBe(true)
  })

  it('a real failure still does both', () => {
    const [run] = runs([
      text('a', 0),
      tool('x', 1, { result: { ok: false, text: 'boom', truncated: false } }),
      text('b', 2),
    ])
    expect(runFlock(run!, { live: false })).toBe('failed')
    expect(runFolded(run!, { live: false })).toBe(false)
  })
})

describe('foldRuns', () => {
  it('groups thinking, tool and task rows between two pieces of text, timed until what followed', () => {
    const entries = [
      text('a', 0),
      thought('th', 1),
      tool('t1', 2),
      tool('t2', 30),
      tool('t3', 60),
      text('b', 135),
    ]
    const items = fold(entries)
    expect(items.map(i => i.kind)).toEqual(['assistant', 'run', 'assistant'])
    const run = items[1] as RunItem
    expect(run.id).toBe('steps-th')
    expect(run.rows.map(r => r.id)).toEqual(['th', 't1', 't2', 't3'])
    expect(run.durationMs).toBe(134_000)
    expect(runLabel(run)).toBe('Worked for 2m 14s')
  })

  it('keeps a lone call and an artifact-posting call in the run', () => {
    expect(fold([tool('t1', 0), text('a', 5)]).map(i => i.kind)).toEqual(['run', 'assistant'])
    const [run] = runs([tool('t2', 6), artifact('art', 7), tool('t3', 8)])
    expect(run!.rows.map(r => r.id)).toEqual(['t2', 'art', 't3'])
  })

  it('keeps the run id while it grows, and times to the last step at the end', () => {
    const two = fold([tool('t1', 0), tool('t2', 10)])
    const three = fold([tool('t1', 0), tool('t2', 10), tool('t3', 20)])
    expect(two[0]!.id).toBe(three[0]!.id)
    expect((three[0] as RunItem).durationMs).toBe(20_000)
  })

  it('says only the count when there are no timestamps', () => {
    const [run] = runs([tool('t1', 0, { at: null }), tool('t2', 0, { at: null })])
    expect(run!.durationMs).toBeNull()
    expect(runLabel(run!)).toBe('Worked')
  })

  it('counts agents in the label', () => {
    const [run] = runs([tool('t1', 0), tool('ag', 1, { name: 'Agent', input: {} })])
    expect(runLabel(run!)).toBe('Worked for 1s · 1 agent')
  })
})

describe('runFolded', () => {
  const run = (entries: TranscriptEntry[], running = false) =>
    foldRuns(
      buildRows(entries, { pending: [], streaming: [], running, artifacts: [] }),
      entries,
    )[0] as RunItem
  const two = [tool('t1', 0), tool('t2', 1)]

  it('stays open while live and folds once settled', () => {
    expect(runFolded(run(two), { live: true })).toBe(false)
    expect(runFolded(run(two), { live: false })).toBe(true)
  })

  it('never folds a single step', () => {
    expect(runFolded(run([tool('t1', 0)]), { live: false })).toBe(false)
  })

  it('does not auto-fold with a failed step, an awaiting step or an artifact card', () => {
    const failed = tool('f', 2, { result: { ok: false, text: 'boom', truncated: false } })
    expect(runFolded(run([...two, failed]), { live: false })).toBe(false)
    expect(runFolded(run([...two, artifact('art', 2)]), { live: false })).toBe(false)
    const waiting = tool('w', 2, { result: undefined })
    const entries = [...two, waiting]
    const rows = buildRows(entries, {
      pending: [{ id: 'p', toolUseId: 'w', toolName: 'Read', input: {}, kind: 'tool' } as never],
      streaming: [],
      running: true,
      artifacts: [],
    })
    expect(runFolded(foldRuns(rows, entries)[0] as RunItem, { live: false })).toBe(false)
  })

  it('lets a still-running background step stay out of the way once something follows', () => {
    const running = tool('r', 2, { result: undefined })
    expect(runFolded(run([...two, running], true), { live: false })).toBe(true)
  })

  it('lets the user decide', () => {
    expect(runFolded(run(two), { live: false, override: false })).toBe(false)
    expect(runFolded(run(two), { live: true, override: true })).toBe(true)
  })
})

describe('runFlock', () => {
  const rowsOf = (entries: TranscriptEntry[], running = false) =>
    buildRows(entries, { pending: [], streaming: [], running, artifacts: [] })
  const run = (entries: TranscriptEntry[], running = false) =>
    foldRuns(rowsOf(entries, running), entries)[0] as RunItem
  const two = [tool('t1', 0), tool('t2', 1)]
  const agent = (id: string, state: 'running' | 'completed'): TranscriptEntry => ({
    kind: 'task',
    id: `task-${id}`,
    at: at(2),
    parentToolUseId: null,
    task: {
      taskId: id,
      runId: null,
      kind: 'agent',
      label: `Review ${id}`,
      state,
      toolUseId: null,
      parentToolUseId: null,
      childSessionId: null,
      startedAt: at(2),
      completedAt: state === 'completed' ? at(5) : null,
      observedAt: null,
    },
  })

  it('flies while the run is live, whatever its steps say', () => {
    const failed = tool('f', 2, { result: { ok: false, text: 'boom', truncated: false } })
    expect(runFlock(run(two), { live: true })).toBe('working')
    expect(runFlock(run([...two, failed]), { live: true })).toBe('working')
  })

  it('lands when the run is over', () => {
    expect(runFlock(run(two), { live: false })).toBe('landed')
  })

  it('scatters when a step failed', () => {
    const failed = tool('f', 2, { result: { ok: false, text: 'boom', truncated: false } })
    expect(runFlock(run([...two, failed]), { live: false })).toBe('failed')
  })

  it('has no flock while a step waits on the user', () => {
    const entries = [...two, tool('w', 2, { result: undefined })]
    const rows = buildRows(entries, {
      pending: [{ id: 'p', toolUseId: 'w', toolName: 'Read', input: {}, kind: 'tool' } as never],
      streaming: [],
      running: true,
      artifacts: [],
    })
    expect(runFlock(foldRuns(rows, entries)[0] as RunItem, { live: false })).toBeNull()
  })

  it('counts the subagents that are out, and lets them run under the working line', () => {
    const out = [
      ...two,
      agent('one', 'running'),
      agent('two', 'running'),
      agent('three', 'completed'),
    ]
    expect(runningAgents(rowsOf(out, true))).toBe(2)
    expect(runBusy(run(out, true))).toBe(false)
    expect(runningAgents(rowsOf([...two, agent('one', 'completed')], true))).toBe(0)
    expect(runningAgents(rowsOf(two, true))).toBe(0)
    // a step of the session's own that is running says so itself
    expect(runBusy(run([...two, tool('r', 2, { result: undefined })], true))).toBe(true)
  })
})

describe('formatWorked', () => {
  it('reads like a stopwatch', () => {
    expect(formatWorked(14_000)).toBe('14s')
    expect(formatWorked(134_000)).toBe('2m 14s')
    expect(formatWorked(3_900_000)).toBe('1h 5m')
  })
})
