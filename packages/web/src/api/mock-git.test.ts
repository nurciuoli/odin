// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ServerEvent } from '@odin/shared/events'
import { createMockApi } from './mock'
import { FIXTURE_SESSION_IDS } from './fixtures'
import { ApiRequestError } from './types'

function setup() {
  const api = createMockApi()
  const events: ServerEvent[] = []
  api.subscribe(e => events.push(e))
  const t = { kind: 'session' as const, id: FIXTURE_SESSION_IDS.waiting }
  return { api, events, t }
}

describe('mock api: git', () => {
  it('stages one hunk of a file and announces the change', async () => {
    const { api, events, t } = setup()
    const before = await api.gitStatus(t)
    expect(before.staged.map(c => c.path)).toHaveLength(2)
    const file = before.unstaged.find(c => c.path.endsWith('SessionSide.vue'))!
    const diff = await api.gitDiff(t, file.path, false)
    const after = await api.gitStage(t, { hunks: [{ path: file.path, hunkId: diff.hunks[0]!.id }] })
    expect(after.staged.some(c => c.path === file.path)).toBe(true)
    expect(after.unstaged.some(c => c.path === file.path)).toBe(true)
    expect(events.some(e => e.type === 'git.changed')).toBe(true)
  })

  it('commits what is staged and refuses an empty commit', async () => {
    const { api, t } = setup()
    const r = await api.gitCommit(t, { message: 'feat: prompt' })
    expect(r.status.staged).toHaveLength(0)
    expect((await api.gitLog(t, { limit: 1 })).commits[0]!.subject).toBe('feat: prompt')
    await expect(api.gitCommit(t, { message: 'again' })).rejects.toMatchObject({ code: 'nothing-to-commit' })
  })

  it('refuses a dirty switch, then stashes and brings the changes back on return', async () => {
    const { api, t } = setup()
    const err = await api.gitCheckout(t, { branch: 'main' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect((err as ApiRequestError).code).toBe('dirty-tree')
    const from = (await api.gitStatus(t)).branch!
    const away = await api.gitCheckout(t, { branch: 'main', dirty: 'stash' })
    expect(away.stashed).toBe('stash@{0}')
    expect(away.status.unstaged).toHaveLength(0)
    const back = await api.gitCheckout(t, { branch: from })
    expect(back.restored).toBe(true)
    expect(back.status.unstaged.length).toBeGreaterThan(0)
  })

  it('needs a rebase or merge to pull a diverged branch', async () => {
    const { api, t } = setup()
    await expect(api.gitPull(t, { strategy: 'ff-only' })).rejects.toMatchObject({ code: 'diverged' })
    const pulled = await api.gitPull(t, { strategy: 'rebase' })
    expect(pulled.status.behind).toBe(0)
    const pushed = await api.gitPush(t, {})
    expect(pushed.message).toBe('Pushed 2 commits')
  })
})
