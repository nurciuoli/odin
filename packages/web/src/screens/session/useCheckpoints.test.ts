import { describe, expect, it } from 'vitest'
import type { Checkpoint } from '@odin/shared/api'
import { checkpointSummary } from './useCheckpoints'

const cp = (o: Partial<Checkpoint>): Checkpoint => ({
  id: 's:1',
  sessionId: 's',
  kind: 'turn',
  messageId: 'm',
  turn: 1,
  at: '2026-11-18T10:00:00Z',
  files: null,
  snapshot: 'ok',
  ...o,
})

describe('checkpointSummary', () => {
  it('says nothing while the turn runs', () => expect(checkpointSummary(cp({}))).toBeNull())
  it('counts changed, added and removed files', () => {
    expect(checkpointSummary(cp({ files: { changed: 1, added: 1, removed: 1 } }))).toBe(
      '3 files changed',
    )
    expect(checkpointSummary(cp({ files: { changed: 1, added: 0, removed: 0 } }))).toBe(
      '1 file changed',
    )
    expect(checkpointSummary(cp({ files: { changed: 0, added: 0, removed: 0 } }))).toBe(
      'no file changes',
    )
  })
  it('says when files were not saved', () => {
    expect(checkpointSummary(cp({ snapshot: 'skipped' }))).toBe('files not saved (too large)')
    expect(checkpointSummary(cp({ snapshot: 'failed' }))).toBe('files not saved')
  })
})
