// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { NotebookSnapshot } from '@odin/shared/notebooks'
import { draftDirty, notebookDraft, receiveNotebook } from './notebookDraft'
const snapshot = (revision = '1', source = 'a = 1'): NotebookSnapshot => ({
  kernel: {
    id: 'kernel',
    project: 'odin',
    name: 'Analysis',
    cwd: '/repo',
    interpreter: '/repo/.venv/bin/python',
    location: { kind: 'native' },
    state: 'idle',
    createdAt: '',
    updatedAt: '',
    error: null,
  },
  revision,
  editor: 'odin',
  cells: [
    {
      id: 'cell',
      kind: 'code',
      source,
      outputs: [],
      executionCount: null,
      author: { kind: 'human' },
    },
  ],
})
describe('notebook drafts', () => {
  it('preserves local changes when a streamed update advances the notebook', () => {
    const draft = notebookDraft(snapshot())
    draft.cells[0]!.source = 'my pending edit'
    const next = receiveNotebook(draft, snapshot('2', 'agent edit'))
    expect(next.cells[0]!.source).toBe('my pending edit')
    expect(next.base.revision).toBe('1')
    expect(next.remote?.cells[0]!.source).toBe('agent edit')
    expect(draftDirty(next)).toBe(true)
  })
  it('accepts new output when the draft is clean without sharing mutable cell state', () => {
    const next = receiveNotebook(notebookDraft(snapshot()), snapshot('2', 'new'))
    expect(next.remote).toBeNull()
    expect(next.cells[0]!.source).toBe('new')
    next.cells[0]!.source = 'local'
    expect(next.base.cells[0]!.source).toBe('new')
  })
})
