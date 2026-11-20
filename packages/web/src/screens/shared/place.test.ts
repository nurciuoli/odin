import { describe, expect, it } from 'vitest'
import type { Session } from '@odin/shared/api'
import { placeFolder, placeLabel, sessionPlace } from './place'

const checkout = {
  project: 'odin',
  workspace: { kind: 'checkout' as const },
  branch: 'main',
  projects: ['odin'],
}
const worktree = {
  project: 'odin',
  workspace: { kind: 'worktree' as const, path: '/r/wt/feat-x', branch: 'feat/x' },
  branch: 'feat/x',
  projects: ['odin', 'other'],
}

describe('placeLabel', () => {
  it('joins the branch and the folder', () => {
    expect(placeLabel('main', 'odin')).toBe('main · odin')
    expect(placeLabel('main', '')).toBe('main')
    expect(placeLabel(null, 'odin')).toBe('odin')
    expect(placeLabel(null, null)).toBe('')
  })
  it('uses the project for a checkout and the directory for a worktree', () => {
    expect(placeFolder(checkout, 'Odin')).toBe('Odin')
    expect(placeFolder(worktree, 'Odin')).toBe('feat-x')
    expect(sessionPlace(checkout as Session, 'Odin')).toBe('main · Odin')
    expect(sessionPlace(worktree as Session)).toBe('feat/x · feat-x +1')
  })
})
