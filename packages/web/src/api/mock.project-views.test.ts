// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ServerEvent } from '@odin/shared/events'
import { createMockApi } from './mock'
import { localDay } from './fixtures'
import { ApiRequestError } from './types'

function withEvents() {
  const api = createMockApi()
  const events: ServerEvent[] = []
  api.subscribe(e => events.push(e))
  return { api, events }
}
const status = (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: unknown) => (e instanceof ApiRequestError ? e.status : -1),
  )

describe('mock api: project views', () => {
  it('worktrees: the checkout and two worktrees; start can use an existing one', async () => {
    const { api } = withEvents()
    const wt = await api.listProjectWorktrees('odin')
    expect(wt.worktrees.map(w => w.main)).toEqual([true, false, false])
    expect(wt.worktrees.some(w => w.sessions.some(s => s.running))).toBe(true)
    expect(wt.worktrees.some(w => w.merged)).toBe(true)
    expect(await status(api.listProjectWorktrees('nope'))).toBe(404)
    const target = wt.worktrees[1]!
    const s = await api.startSession({
      project: 'odin',
      prompt: { text: 'hi' },
      where: { kind: 'worktree', path: target.path },
    })
    expect(s.cwd).toBe(target.path)
    expect(s.branch).toBe(target.branch)
    expect(
      await status(
        api.startSession({
          project: 'odin',
          prompt: { text: 'x' },
          where: { kind: 'worktree', path: '/nowhere' },
        }),
      ),
    ).toBe(400)
  })

  it('activity: 84 local days ending today, no gaps, deterministic', async () => {
    const { api } = withEvents()
    const { days } = await api.getProjectActivity('odin')
    expect(days).toHaveLength(84)
    expect(days.at(-1)!.date).toBe(localDay(new Date()))
    expect(days.some(d => d.sessions > 0)).toBe(true)
    const again = await createMockApi().getProjectActivity('odin')
    expect(again.days.map(d => d.sessions)).toEqual(days.map(d => d.sessions))
    expect((await api.getProjectActivity('odin', 7)).days).toHaveLength(7)
    expect(await status(api.getProjectActivity('odin', 0))).toBe(400)
    const [summary] = await api.listProjects()
    expect(summary!.activity).toEqual(days.slice(-14).map(d => d.sessions))
  })

  it('artifacts newest first, with limit', async () => {
    const { api } = withEvents()
    const all = await api.listProjectArtifacts('odin')
    expect(new Set(all.map(a => a.sessionId)).size).toBe(2)
    expect(all.map(a => a.updatedAt)).toEqual([...all.map(a => a.updatedAt)].sort().reverse())
    expect(await api.listProjectArtifacts('odin', 1)).toHaveLength(1)
  })

  it('branches and worktree removal', async () => {
    const { api } = withEvents()
    const branches = await api.listProjectBranches('odin')
    expect(branches).toHaveLength(4)
    expect(branches.filter(b => b.current)).toHaveLength(1)
    const stale = branches.find(b => b.name.startsWith('odin/keep-runner'))!
    await api.removeWorktree('odin', stale.worktreePath!)
    const after = await api.listProjectBranches('odin')
    expect(after.find(b => b.name === stale.name)!.worktreePath).toBeNull()
    expect(await status(api.removeWorktree('odin', '/home/me/code/odin'))).toBe(400)
  })
})
