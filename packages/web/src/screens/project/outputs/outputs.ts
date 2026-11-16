// Pull requests from a project's sessions, one row per PR number with the sessions behind it.
import type { PullRef, Session } from '@odin/shared/api'

export interface PullRow {
  pull: PullRef
  status: 'open' | 'merged' | 'closed'
  sessions: Pick<Session, 'id' | 'title'>[]
  updatedAt: string
}

export function pullsOf(
  sessions: Pick<Session, 'id' | 'title' | 'pull' | 'updatedAt'>[],
): PullRow[] {
  const byNumber = new Map<number, PullRow>()
  for (const s of sessions) {
    if (!s.pull) continue
    const row = byNumber.get(s.pull.number)
    if (row) {
      row.sessions.push({ id: s.id, title: s.title })
      if (s.updatedAt > row.updatedAt) row.updatedAt = s.updatedAt
    } else
      byNumber.set(s.pull.number, {
        pull: s.pull,
        status: s.pull.merged ? 'merged' : s.pull.state,
        sessions: [{ id: s.id, title: s.title }],
        updatedAt: s.updatedAt,
      })
  }
  const order = { open: 0, merged: 1, closed: 2 }
  return [...byNumber.values()].sort(
    (a, b) => order[a.status] - order[b.status] || b.updatedAt.localeCompare(a.updatedAt),
  )
}
