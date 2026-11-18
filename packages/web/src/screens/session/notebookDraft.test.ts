// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { NotebookSnapshot } from '@odin/shared/notebooks'
import { draftDirty, notebookDraft, receiveNotebook } from './notebookDraft'
const snapshot = (revision = '1', source = 'a = 1'): NotebookSnapshot => ({
  kernel: {
    id: 'kernel',
    project: 'odin',
    path: 'Analysis.ipynb',
    name: 'Analysis.ipynb',
    cwd: '/repo',
    interpreter: '/repo/.venv/bin/python',
    location: { kind: 'native' },
    state: 'idle',
    createdAt: '',
    updatedAt: '',
    error: null,
  },
  revision,
  cells: [
    {
      id: 'cell',
      kind: 'code',
      source,
      outputs: [],
      executionCount: null,
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
describe('notebook runs', () => {
  it('takes kernel output into a dirty draft without a conflict', () => {
    const draft = notebookDraft(snapshot())
    draft.cells[0]!.source = 'a = 2'
    const ran = snapshot('2')
    ran.cells[0]!.outputs = [{ type: 'stream', name: 'stdout', text: 'hi' }]
    ran.cells[0]!.executionCount = 1
    const next = receiveNotebook(draft, ran)
    expect(next.remote).toBeNull()
    expect(next.cells[0]!.source).toBe('a = 2')
    expect(next.cells[0]!.outputs).toHaveLength(1)
    expect(next.base.revision).toBe('2')
    expect(draftDirty(next)).toBe(true)
  })
  it('does not call outputs or line endings an unsaved change', () => {
    const draft = notebookDraft(snapshot('1', 'a = 1\r\nb = 2'))
    draft.cells[0]!.source = 'a = 1\nb = 2'
    draft.cells[0]!.outputs = []
    expect(draftDirty(draft)).toBe(false)
  })
})
