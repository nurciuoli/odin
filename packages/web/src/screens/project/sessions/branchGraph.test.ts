// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ProjectBranch } from '@odin/shared/api'
import { branchGraph, branchKind, canRemoveWorktree, STALE_MS } from './branchGraph'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const b = (over: Partial<ProjectBranch>): ProjectBranch => ({
  name: 'x',
  headSha: 'abc',
  ahead: 2,
  behind: 1,
  merged: false,
  lastCommitAt: new Date(NOW - 1000).toISOString(),
  worktreePath: null,
  current: false,
  sessionIds: [],
  pull: null,
  ...over,
})
const old = new Date(NOW - STALE_MS - 1000).toISOString()

describe('branchKind', () => {
  it('classifies current, merged, open PR, stale worktree and open', () => {
    expect(branchKind(b({ current: true, merged: true }), NOW)).toBe('current')
    expect(branchKind(b({ merged: true }), NOW)).toBe('merged')
    expect(
      branchKind(b({ pull: { number: 1, url: 'u', state: 'open', merged: false } }), NOW),
    ).toBe('pull')
    expect(branchKind(b({ worktreePath: '/w', lastCommitAt: old }), NOW)).toBe('stale')
    expect(branchKind(b({ lastCommitAt: old }), NOW)).toBe('open')
  })
})

describe('canRemoveWorktree', () => {
  const sessions = new Map([
    ['live', { state: 'running' as const }],
    ['done', { state: 'ended' as const }],
  ])
  it('allows merged or stale worktrees with no live session', () => {
    expect(canRemoveWorktree(b({ worktreePath: '/w', merged: true }), sessions, NOW)).toBe(true)
    expect(
      canRemoveWorktree(
        b({ worktreePath: '/w', lastCommitAt: old, sessionIds: ['done'] }),
        sessions,
        NOW,
      ),
    ).toBe(true)
  })
  it('refuses without a worktree, on open branches, the checkout, or with a live session', () => {
    expect(canRemoveWorktree(b({ merged: true }), sessions, NOW)).toBe(false)
    expect(canRemoveWorktree(b({ worktreePath: '/w' }), sessions, NOW)).toBe(false)
    expect(
      canRemoveWorktree(b({ worktreePath: '/w', merged: true, current: true }), sessions, NOW),
    ).toBe(false)
    expect(
      canRemoveWorktree(
        b({ worktreePath: '/w', merged: true, sessionIds: ['live'] }),
        sessions,
        NOW,
      ),
    ).toBe(false)
  })
})

describe('branchGraph', () => {
  it('drops the trunk, forks by behind, and marks sessions and PRs', () => {
    const sessions = new Map([['s1', { id: 's1', title: 'Fix', state: 'running' as const }]])
    const g = branchGraph(
      'main',
      [
        b({ name: 'main', current: true }),
        b({ name: 'old', behind: 5, ahead: 0, merged: true }),
        b({
          name: 'feat',
          behind: 1,
          ahead: 3,
          worktreePath: '/w',
          sessionIds: ['s1', 'gone'],
          pull: { number: 7, url: 'u', state: 'open', merged: false },
        }),
      ],
      sessions,
      NOW,
    )
    expect(g.trunk).toBe('main')
    expect(g.branches.map(x => x.name)).toEqual(['old', 'feat'])
    const [old, feat] = g.branches
    expect(old).toMatchObject({
      forkAt: 1,
      length: 1,
      intent: 'positive',
      end: 'merged',
      dashed: false,
    })
    expect(feat).toMatchObject({
      forkAt: 5,
      length: 3,
      intent: 'accent',
      end: 'open',
      dashed: true,
    })
    expect(feat!.marks).toEqual([
      {
        at: 7,
        intent: 'accent',
        label: 'Session: Fix',
        to: { name: 'session', params: { id: 's1' } },
      },
      { at: 8, intent: 'accent', label: 'PR #7 open' },
    ])
  })
})
