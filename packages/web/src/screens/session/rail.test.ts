// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@odin/shared/harness'
import { railRun } from './rail'
import { buildRows } from './sessionView'
import { foldRuns, type RunItem } from './steps'

const entry = (id: string, status: 'denied' | 'interrupted', text: string): TranscriptEntry => ({
  kind: 'tool',
  id,
  name: 'Bash',
  input: { command: 'ls' },
  result: { ok: false, status, text, truncated: false },
  at: null,
  parentToolUseId: null,
})

describe('railRun with user-refused tools', () => {
  it('shows a neutral Denied / Stopped step, not failed', () => {
    const entries = [entry('d', 'denied', 'Denied'), entry('i', 'interrupted', 'Stopped by you')]
    const rows = buildRows(entries, { pending: [], streaming: [], running: false, artifacts: [] })
    const run = foldRuns(rows, entries).find((i): i is RunItem => i.kind === 'run')!
    const { steps, bodies } = railRun(run, { times: new Map() })
    expect(steps.map(s => [s.status, s.meta])).toEqual([
      ['cancelled', 'Denied'],
      ['cancelled', 'Stopped'],
    ])
    expect(bodies.get('i')).toMatchObject({
      kind: 'call',
      call: { result: { text: 'Stopped by you' } },
    })
  })
})
