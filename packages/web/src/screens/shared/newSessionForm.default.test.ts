// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { recentBranchPrefixes, worktreeDefault } from './newSessionForm'

describe('worktreeDefault', () => {
  const settings = { defaultWorktree: true } as never
  it('prefers the project override, either way', () => {
    expect(worktreeDefault({ defaultWorktree: false }, settings)).toBe(false)
    expect(worktreeDefault({ defaultWorktree: true }, { defaultWorktree: false } as never)).toBe(
      true,
    )
  })
  it('falls back to the global setting, then false', () => {
    expect(worktreeDefault({}, settings)).toBe(true)
    expect(worktreeDefault(null, settings)).toBe(true)
    expect(worktreeDefault(undefined, undefined)).toBe(false)
  })
})

describe('recentBranchPrefixes', () => {
  it('returns unique prefixes from the newest branches first', () => {
    const branches = [
      { name: 'main', lastCommitAt: '2026-11-01T00:00:00Z' },
      { name: 'fix/a', lastCommitAt: '2026-11-03T00:00:00Z' },
      { name: 'feat/b', lastCommitAt: '2026-11-05T00:00:00Z' },
      { name: 'feat/c', lastCommitAt: '2026-11-04T00:00:00Z' },
    ]
    expect(recentBranchPrefixes(branches)).toEqual(['feat/', 'fix/'])
    expect(recentBranchPrefixes(branches, 1)).toEqual(['feat/'])
    expect(recentBranchPrefixes([{ name: 'main', lastCommitAt: null }])).toEqual([])
  })
})
