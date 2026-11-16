// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '@odin/shared/harness'
import { defaultTab, fileChanges, hasWork, latestPlan } from './workbench'

const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  ok = true,
): TranscriptEntry => ({
  kind: 'tool',
  id,
  name,
  input,
  result: { ok, text: '', truncated: false },
  at: null,
  parentToolUseId: null,
})

describe('workbench', () => {
  it('counts changed lines per file from edit inputs', () => {
    const entries = [
      tool('1', 'Edit', { file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\ny\nz' }),
      tool('2', 'Write', { file_path: 'b.ts', content: 'one\ntwo' }),
      tool('3', 'Edit', { file_path: 'a.ts', old_string: 'q', new_string: 'r' }),
      tool('4', 'Edit', { file_path: 'a.ts', old_string: 'q', new_string: 'r' }, false),
      tool('5', 'Read', { file_path: 'c.ts' }),
      tool('6', 'search_replace', { file_path: 'd.ts', old_string: 'a', new_string: 'b\nc' }),
    ]
    expect(fileChanges(entries)).toEqual([
      { path: 'a.ts', edits: 3, failed: true, added: 4, removed: 3 },
      { path: 'b.ts', edits: 1, failed: false, added: 2, removed: 0 },
      { path: 'd.ts', edits: 1, failed: false, added: 2, removed: 1 },
    ])
  })

  it('finds the latest plan and picks the opening tab', () => {
    const plan = tool('p', 'ExitPlanMode', { plan: '1. Do it' })
    expect(latestPlan([plan])).toBe('1. Do it')
    expect(defaultTab({ artifacts: [], todos: [], transcript: [plan] })).toBe('plan')
    expect(defaultTab({ artifacts: [], todos: [], transcript: [] })).toBe('changes')
    expect(hasWork({ artifacts: [], todos: [], transcript: [] })).toBe(false)
    expect(
      hasWork({ artifacts: [], todos: [], transcript: [tool('1', 'Write', { file_path: 'a' })] }),
    ).toBe(true)
  })
})
