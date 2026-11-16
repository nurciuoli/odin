// @vitest-environment node
import { expect, it } from 'vitest'
import type { PullRef } from '@odin/shared/api'
import { pullsOf } from './outputs'

const pr = (number: number, state: 'open' | 'closed', merged = false): PullRef => ({
  number,
  url: `https://github.com/o/r/pull/${number}`,
  state,
  merged,
})

it('groups sessions by PR, open first, then newest', () => {
  const rows = pullsOf([
    { id: 'a', title: 'A', pull: pr(1, 'closed', true), updatedAt: '2026-01-02' },
    { id: 'b', title: 'B', pull: pr(2, 'open'), updatedAt: '2026-01-01' },
    { id: 'c', title: 'C', pull: pr(1, 'closed', true), updatedAt: '2026-01-03' },
    { id: 'd', title: 'D', pull: null, updatedAt: '2026-01-04' },
  ])
  expect(rows.map(r => [r.pull.number, r.status, r.sessions.map(s => s.id)])).toEqual([
    [2, 'open', ['b']],
    [1, 'merged', ['a', 'c']],
  ])
})
