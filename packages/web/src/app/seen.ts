// Which finished sessions the user has opened. Client-side only: `odin:seen` in localStorage maps a session id to
// the `updatedAt` it had when it was last opened. A session that stopped (idle, ended or failed) after that, and
// recently, is "unread": Home keeps it with the active sessions until it is opened.
import { ref } from 'vue'
import type { Session } from '@odin/shared/api'

const KEY = 'odin:seen'
const LIMIT = 200
/** Without a record, only sessions that stopped this recently count as unread (an old install has no history). */
export const UNREAD_WINDOW = 24 * 60 * 60 * 1000

function read(): Record<string, string> {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Record<string, string>) : {}
  } catch {
    return {}
  }
}

const seen = ref<Record<string, string>>(read())

/** Records that `session` was opened at its current `updatedAt`. */
export function markSeen(session: Pick<Session, 'id' | 'updatedAt'>) {
  if (seen.value[session.id] === session.updatedAt) return
  const next = { ...seen.value }
  delete next[session.id] // re-insert last so the oldest entries drop first
  next[session.id] = session.updatedAt
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - LIMIT))) {
    if (Date.now() - Date.parse(next[id]!) >= UNREAD_WINDOW) delete next[id]
  }
  seen.value = next
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage off: unread state lasts for this page only
  }
}

/** Marks the supplied finished sessions read at their current update times. */
export function markAllSeen(sessions: readonly Pick<Session, 'id' | 'updatedAt'>[]) {
  if (!sessions.length) return
  const next = { ...seen.value }
  for (const session of sessions) {
    delete next[session.id]
    next[session.id] = session.updatedAt
  }
  // Keep every bulk-marked id, even when the unread list exceeds LIMIT. Pruning here would make
  // older sessions without an existing record become unread again on the next render.
  seen.value = next
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // storage off: unread state lasts for this page only
  }
}

/** A stopped session the user hasn't opened since it stopped. Reads reactive state, so it can sit in a computed. */
export function isUnread(session: Session, now = Date.now()): boolean {
  if (session.state === 'running' || session.state === 'waiting') return false
  if (session.aside || session.archived) return false
  const at = Date.parse(session.updatedAt)
  if (Number.isNaN(at)) return false
  const last = seen.value[session.id]
  if (last) return at > Date.parse(last)
  return now - at < UNREAD_WINDOW
}

export function resetSeen() {
  seen.value = {}
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // ignore
  }
}
