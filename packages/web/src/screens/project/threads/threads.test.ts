import { describe, expect, it } from 'vitest'
import type { CoordinatorThread, SessionState } from '@odin/shared/api'
import { memoryPathError, sortThreads, threadSummary } from './threads'

const thread = (id: string, state: SessionState, createdAt: string): CoordinatorThread =>
  ({
    sessionId: id,
    coordinatorId: 'c',
    task: id,
    createdAt,
    session: { id, state },
  }) as CoordinatorThread

describe('sortThreads', () => {
  it('puts threads that need the user first, then running, newest first within a state', () => {
    const sorted = sortThreads([
      thread('idle', 'idle', '2026-11-01T03:00:00Z'),
      thread('run-old', 'running', '2026-11-01T01:00:00Z'),
      thread('wait', 'waiting', '2026-11-01T00:00:00Z'),
      thread('run-new', 'running', '2026-11-01T02:00:00Z'),
      thread('ended', 'ended', '2026-11-01T05:00:00Z'),
      thread('failed', 'failed', '2026-11-01T04:00:00Z'),
    ])
    expect(sorted.map(t => t.sessionId)).toEqual([
      'wait',
      'run-new',
      'run-old',
      'failed',
      'idle',
      'ended',
    ])
  })
})

describe('threadSummary', () => {
  it('counts what matters', () => {
    expect(threadSummary([])).toBe('No threads yet')
    expect(threadSummary([thread('a', 'idle', '')])).toBe('1 thread')
    expect(
      threadSummary([
        thread('a', 'waiting', ''),
        thread('b', 'running', ''),
        thread('c', 'failed', ''),
        thread('d', 'idle', ''),
      ]),
    ).toBe('4 threads · 1 needs you · 1 running · 1 failed')
  })
})

describe('memoryPathError', () => {
  it('accepts relative Markdown paths', () => {
    expect(memoryPathError('MEMORY.md')).toBeNull()
    expect(memoryPathError('pitfalls/sse-reconnect.md')).toBeNull()
  })
  it.each(['', 'notes.txt', '../x.md', '/abs.md', '.hidden.md', 'a//b.md', 'a/../b.md'])(
    'refuses %j',
    path => {
      expect(memoryPathError(path)).not.toBeNull()
    },
  )
})
