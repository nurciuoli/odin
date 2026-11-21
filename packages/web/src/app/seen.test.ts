import { afterEach, describe, expect, it } from 'vitest'
import type { Session } from '@odin/shared/api'
import { isUnread, markAllSeen, markSeen, resetSeen, UNREAD_WINDOW } from './seen'

const NOW = Date.parse('2026-11-13T12:00:00Z')
const session = (over: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    state: 'idle',
    updatedAt: new Date(NOW - 60_000).toISOString(),
    aside: false,
    archived: false,
    ...over,
  }) as Session

afterEach(() => resetSeen())

describe('seen sessions', () => {
  it('counts a recently stopped session as unread until it is opened', () => {
    const s = session()
    expect(isUnread(s, NOW)).toBe(true)
    markSeen(s)
    expect(isUnread(s, NOW)).toBe(false)
  })
  it('is unread again when the session changes after it was opened', () => {
    markSeen(session())
    const later = session({ updatedAt: new Date(NOW).toISOString() })
    expect(isUnread(later, NOW)).toBe(true)
  })
  it('keeps imported history quiet until it has conversation activity', () => {
    const history = session({ activityAt: null })
    expect(isUnread(history, NOW)).toBe(false)
    markSeen(history)
    markAllSeen([history])
    expect(JSON.parse(window.localStorage.getItem('odin:seen') ?? '{}')).not.toHaveProperty('s1')
    expect(isUnread({ ...history, activityAt: history.updatedAt }, NOW)).toBe(true)
  })
  it('marks the activity time read and ignores newer metadata timestamps', () => {
    const activity = session({ activityAt: new Date(NOW - 60_000).toISOString() })
    const renamed = { ...activity, updatedAt: new Date(NOW).toISOString() }
    markAllSeen([renamed])
    expect(JSON.parse(window.localStorage.getItem('odin:seen')!)).toHaveProperty(
      's1',
      activity.activityAt,
    )
    expect(isUnread(renamed, NOW)).toBe(false)
    expect(isUnread({ ...renamed, activityAt: renamed.updatedAt }, NOW)).toBe(true)
  })
  it('preserves read markers saved by an older client', () => {
    const beforeUpgrade = session()
    markSeen(beforeUpgrade)
    const migrated = {
      ...beforeUpgrade,
      updatedAt: new Date(NOW).toISOString(),
      activityAt: beforeUpgrade.updatedAt,
    }
    expect(isUnread(migrated, NOW)).toBe(false)
  })
  it('never lists running, waiting, side or archived sessions, or old ones with no record', () => {
    expect(isUnread(session({ state: 'running' }), NOW)).toBe(false)
    expect(isUnread(session({ state: 'waiting' }), NOW)).toBe(false)
    expect(isUnread(session({ aside: true }), NOW)).toBe(false)
    expect(isUnread(session({ archived: true }), NOW)).toBe(false)
    const old = session({ updatedAt: new Date(NOW - UNREAD_WINDOW - 1000).toISOString() })
    expect(isUnread(old, NOW)).toBe(false)
  })
  it('persists in localStorage', () => {
    markSeen(session())
    expect(JSON.parse(window.localStorage.getItem('odin:seen')!)).toHaveProperty('s1')
  })
  it('marks every supplied session read, including batches larger than the single-open cache limit', () => {
    const now = Date.now()
    const batch = Array.from({ length: 240 }, (_, i) =>
      session({ id: `s${i}`, updatedAt: new Date(now - i * 1000).toISOString() }),
    )
    markAllSeen(batch)
    markSeen(session({ id: 'another', updatedAt: new Date(now).toISOString() }))
    expect(batch.every(s => !isUnread(s, now))).toBe(true)
    expect(Object.keys(JSON.parse(window.localStorage.getItem('odin:seen')!))).toHaveLength(241)
  })
})
