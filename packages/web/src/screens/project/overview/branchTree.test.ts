import { describe, expect, it } from 'vitest'
import type { ProjectBranch } from '@odin/shared/api'
import { branchUrl, commitUrl, treeRows } from './branchTree'

const NOW = Date.parse('2026-11-18T00:00:00Z')
const b = (name: string, over: Partial<ProjectBranch> = {}): ProjectBranch => ({
  name,
  headSha: 'abc1234',
  ahead: 1,
  behind: 0,
  merged: false,
  lastCommitAt: '2026-11-17T00:00:00Z',
  worktreePath: null,
  current: false,
  sessionIds: [],
  pull: null,
  ...over,
})
const list = [
  b('feat/a', { lastCommitAt: '2026-11-16T00:00:00Z' }),
  b('main', { current: true, worktreePath: '/p' }),
  b('done', { merged: true, ahead: 0 }),
  b('wt', { worktreePath: '/w' }),
  b('old', { lastCommitAt: '2026-08-01T00:00:00Z' }),
]
const all = { filter: 'all', worktreesOnly: false } as const

describe('treeRows', () => {
  it('puts the default branch first and sorts the rest newest first', () => {
    expect(treeRows(list, 'main', all, NOW).map(r => r.branch.name)).toEqual([
      'main',
      'done',
      'wt',
      'feat/a',
      'old',
    ])
  })
  it('hides merged branches under the active filter and keeps the default', () => {
    const names = treeRows(list, 'main', { ...all, filter: 'active' }, NOW).map(r => r.branch.name)
    expect(names).not.toContain('done')
    expect(names[0]).toBe('main')
  })
  it('shows only merged branches under the merged filter', () => {
    expect(
      treeRows(list, 'main', { ...all, filter: 'merged' }, NOW).map(r => r.branch.name),
    ).toEqual(['main', 'done'])
  })
  it('narrows to worktrees, not counting the current checkout', () => {
    expect(
      treeRows(list, 'main', { ...all, worktreesOnly: true }, NOW).map(r => r.branch.name),
    ).toEqual(['main', 'wt'])
  })
  it('marks stale open branches and alternates lanes', () => {
    const rows = treeRows(list, 'main', all, NOW)
    expect(rows.find(r => r.branch.name === 'old')?.stale).toBe(true)
    expect(rows.map(r => r.lane)).toEqual([0, 0, 1, 2, 3])
  })
})

describe('links', () => {
  it('builds GitHub links only for a repo, encoding each path segment', () => {
    expect(branchUrl('o/r', 'feat/a b')).toBe('https://github.com/o/r/tree/feat/a%20b')
    expect(commitUrl('o/r', 'abc')).toBe('https://github.com/o/r/commit/abc')
    expect(branchUrl(null, 'x')).toBeNull()
  })
})
