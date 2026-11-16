// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { threadOfSession, upsertSession } from './threadChain'

describe('threadOfSession', () => {
  it('walks up to the root and lists forks under it', async () => {
    const api = createMockApi()
    const sessions = await api.listSessions({ project: 'odin', archived: undefined })
    const fork = sessions.find(s => sessions.some(p => p.id === s.parentId))!
    const t = threadOfSession(sessions, [], fork.id)!
    expect(t.sessions[0]!.depth).toBe(0)
    expect(t.sessions.some(s => s.session.id === fork.id && s.depth > 0)).toBe(true)
  })

  it('returns null for an unknown session', () => {
    expect(threadOfSession([], [], FIXTURE_SESSION_IDS.idle)).toBeNull()
  })

  it('upsertSession replaces by id or prepends', async () => {
    const api = createMockApi()
    const [a, b] = await api.listSessions({ project: 'odin' })
    expect(upsertSession([a!], b!).map(s => s.id)).toEqual([b!.id, a!.id])
    expect(upsertSession([a!], { ...a!, title: 'x' })[0]!.title).toBe('x')
  })
})
