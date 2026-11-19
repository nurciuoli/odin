// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@odin/shared/harness'
import { buildTimeline, stepClock, stepIndex } from './timeline'

const user = (id: string, text: string): TranscriptEntry => ({
  kind: 'user',
  id,
  text,
  at: '2026-11-18T09:12:00.000Z',
  parentToolUseId: null,
})
const say = (id: string, text: string): TranscriptEntry => ({
  kind: 'assistant',
  id,
  text,
  model: 'm',
  at: null,
  parentToolUseId: null,
})
const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  result?: { ok: boolean; status?: 'denied' | 'interrupted' },
  parent: string | null = null,
): TranscriptEntry => ({
  kind: 'tool',
  id,
  name,
  input,
  ...(result
    ? {
        result: {
          ok: result.ok,
          text: '',
          truncated: false,
          ...(result.status ? { status: result.status } : {}),
        },
      }
    : {}),
  at: null,
  parentToolUseId: parent,
})

describe('buildTimeline', () => {
  it('makes one step per user message, in order and numbered from 1', () => {
    const steps = buildTimeline([user('u1', ' First '), say('a1', 'Done.'), user('u2', 'Second')])
    expect(steps.map(s => [s.id, s.n, s.prompt])).toEqual([
      ['u1', 1, 'First'],
      ['u2', 2, 'Second'],
    ])
    expect(steps[0]!.reply).toBe('Done.')
    expect(steps[1]!.reply).toBe('')
  })

  it('keeps the last assistant text as the reply', () => {
    const [s] = buildTimeline([
      user('u1', 'go'),
      say('a1', 'Looking.'),
      tool('t1', 'Read', { file_path: 'a.ts' }, { ok: true }),
      say('a2', 'Fixed it.'),
    ])
    expect(s!.reply).toBe('Fixed it.')
  })

  it('counts calls, distinct edited files, failures and agents', () => {
    const [s] = buildTimeline([
      user('u1', 'go'),
      tool('t1', 'Read', { file_path: 'a.ts' }, { ok: true }),
      tool('t2', 'Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, { ok: true }),
      tool('t3', 'Edit', { file_path: 'a.ts', old_string: 'y', new_string: 'z' }, { ok: true }),
      tool('t4', 'Write', { file_path: 'b.ts', content: '' }, { ok: true }),
      tool('t5', 'Bash', { command: 'yarn test' }, { ok: false }),
      tool('t6', 'Agent', { description: 'look', subagent_type: 'Explore' }, { ok: true }),
    ])
    expect(s).toMatchObject({ tools: 6, files: 2, failed: 1, agents: 1 })
  })

  it('does not count a denied or stopped call as a failure, or nested calls at all', () => {
    const [s] = buildTimeline([
      user('u1', 'go'),
      tool('t1', 'Bash', { command: 'rm -rf x' }, { ok: false, status: 'denied' }),
      tool('t2', 'Bash', { command: 'sleep 9' }, { ok: false, status: 'interrupted' }),
      tool('t3', 'Agent', { description: 'x', subagent_type: 'Explore' }, { ok: true }),
      tool('t4', 'Bash', { command: 'false' }, { ok: false }, 't3'),
    ])
    expect(s).toMatchObject({ tools: 3, failed: 0 })
  })

  it('ignores entries before the first user message', () => {
    expect(buildTimeline([say('a0', 'Hello'), user('u1', 'hi')])).toHaveLength(1)
    expect(buildTimeline([])).toEqual([])
  })
})

describe('stepIndex', () => {
  it('moves and stops at the ends', () => {
    expect(stepIndex(2, 1, 5)).toBe(3)
    expect(stepIndex(4, 1, 5)).toBe(4)
    expect(stepIndex(0, -1, 5)).toBe(0)
    expect(stepIndex(0, 1, 0)).toBe(0)
  })
})

describe('stepClock', () => {
  it('is empty without a usable timestamp', () => {
    expect(stepClock(null)).toBe('')
    expect(stepClock('nope')).toBe('')
    expect(stepClock('2026-11-18T09:12:00.000Z')).toMatch(/^\d{2}:\d{2}$/)
  })
})
