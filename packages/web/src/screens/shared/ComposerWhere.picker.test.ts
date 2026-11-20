import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { ProjectBranch, ProjectWorktrees } from '@odin/shared/api'
import ComposerWhere from './ComposerWhere.vue'

function mountWhere(props: Record<string, unknown> = {}) {
  const w = mount(ComposerWhere, {
    attachTo: document.body,
    props: {
      worktree: false,
      branch: '',
      existing: null,
      open: false,
      'onUpdate:worktree': (v: boolean) => w.setProps({ worktree: v }),
      'onUpdate:branch': (v: string) => w.setProps({ branch: v }),
      'onUpdate:existing': (v: unknown) => w.setProps({ existing: v as null }),
      'onUpdate:open': (v: boolean) => w.setProps({ open: v }),
      ...props,
    },
  })
  return w
}

const info: ProjectWorktrees = {
  mainBranch: 'main',
  baseBranch: 'main',
  worktrees: [
    {
      path: '/r/odin',
      branch: 'main',
      headSha: 'a',
      dirty: true,
      ahead: 0,
      behind: 2,
      main: true,
      merged: false,
      sessions: [],
    },
    {
      path: '/r/wt/feat-x',
      branch: 'feat/x',
      headSha: 'b',
      dirty: false,
      ahead: 1,
      behind: 0,
      main: false,
      merged: true,
      sessions: [{ id: 's1', title: 'T', state: 'running', running: true }],
    },
  ],
}
const branches = [
  { name: 'main', current: true, worktreePath: null },
  { name: 'feat/x', current: false, worktreePath: '/r/wt/feat-x' },
  { name: 'fix/y', current: false, worktreePath: null },
] as ProjectBranch[]
const chip = (w: ReturnType<typeof mountWhere>) => w.find('button[aria-haspopup]')
const filter = (w: ReturnType<typeof mountWhere>) => w.find('input[placeholder="Filter branches"]')

describe('ComposerWhere with the project checkout and worktrees', () => {
  it('names the branch with a dirty marker and the path in the tooltip', () => {
    const w = mountWhere({ info, branches })
    expect(chip(w).text()).toContain('⎇ main · odin')
    expect(chip(w).attributes('aria-label')).toContain('uncommitted changes')
    expect(chip(w).attributes('title')).toContain('/r/odin')
    w.unmount()
  })
  it('falls back to detached', () => {
    const w = mountWhere({
      info: { ...info, mainBranch: null, worktrees: [{ ...info.worktrees[0]!, branch: null }] },
    })
    expect(chip(w).text()).toContain('⎇ detached · odin')
    w.unmount()
  })
  it('lists existing worktrees with running count and merged badge, and picks one', async () => {
    const w = mountWhere({ info, branches, open: true })
    const row = w.find('[data-where="worktree"]')
    expect(row.text()).toContain('feat/x')
    expect(row.text()).toContain('feat-x')
    expect(row.text()).toContain('1 running')
    expect(row.text()).toContain('merged')
    await row.trigger('click')
    expect(w.props('existing')).toEqual({ kind: 'worktree', path: '/r/wt/feat-x' })
    expect(chip(w).text()).toContain('⎇ feat/x · feat-x')
    w.unmount()
  })
  it('filters branches; one checked out in a worktree picks that worktree', async () => {
    const w = mountWhere({ info, branches, open: true })
    await filter(w).setValue('feat')
    expect(w.findAll('[data-where="branch"]')).toHaveLength(1)
    await w.find('[data-where="branch"]').trigger('click')
    expect(w.props('existing')).toEqual({ kind: 'worktree', path: '/r/wt/feat-x' })
    w.unmount()
  })
  it('picks a free branch for a new worktree on it', async () => {
    const w = mountWhere({ info, branches, open: true })
    await filter(w).setValue('fix')
    await filter(w).trigger('keydown', { key: 'Enter' })
    expect(w.props('existing')).toEqual({ kind: 'branch', branch: 'fix/y' })
    expect(chip(w).text()).toContain('⎇ fix/y · new worktree')
    w.unmount()
  })
  it('picking the current branch means the checkout', async () => {
    const w = mountWhere({
      info,
      branches,
      open: true,
      existing: { kind: 'branch', branch: 'fix/y' },
    })
    await filter(w).setValue('main')
    await w.find('[data-where="branch"]').trigger('click')
    expect(w.props('existing')).toBeNull()
    expect(w.props('worktree')).toBe(false)
    w.unmount()
  })
  it('lists only free branches until you type, remote ones included', async () => {
    const w = mountWhere({ info, branches, remoteBranches: ['origin/feat/z'], open: true })
    expect(w.findAll('[data-where="branch"]').map(b => b.find('span').text())).toEqual([
      'fix/y',
      'origin/feat/z',
    ])
    await filter(w).setValue('main')
    expect(w.findAll('[data-where="branch"]')).toHaveLength(1)
    await filter(w).setValue('origin')
    await w.find('[data-where="branch"]').trigger('click')
    expect(w.props('existing')).toEqual({ kind: 'branch', branch: 'origin/feat/z' })
    w.unmount()
  })
  it('keeps the filter and says so when no free branch is left', () => {
    const w = mountWhere({ info, branches: branches.slice(0, 2), open: true })
    expect(filter(w).exists()).toBe(true)
    expect(w.findAll('[data-where="branch"]')).toHaveLength(0)
    expect(w.text()).toContain('No other branches')
    w.unmount()
  })
  it('moves between the option rows with the arrow keys', async () => {
    const w = mountWhere({ info, branches, open: true })
    const rows = w.findAll('[data-rove]')
    ;(rows[0]!.element as HTMLElement).focus()
    await rows[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rows[1]!.element)
    w.unmount()
  })
})
