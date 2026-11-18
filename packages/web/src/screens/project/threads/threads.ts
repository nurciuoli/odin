// Pure helpers for the Threads tab: ordering, the per-coordinator summary line, and memory path checks that mirror
// core's (docs/contracts.md#coordination), so the form can say what's wrong before the request.
import type { CoordinatorThread, SessionState } from '@odin/shared/api'

// What needs the user first, then what's moving, then the rest.
const ORDER: Record<SessionState, number> = { waiting: 0, running: 1, failed: 2, idle: 3, ended: 4 }

/** Waiting threads first, then running, failed, idle, ended; newest first within each. */
export function sortThreads(threads: CoordinatorThread[]): CoordinatorThread[] {
  return threads
    .slice()
    .sort(
      (a, b) =>
        ORDER[a.session.state] - ORDER[b.session.state] || b.createdAt.localeCompare(a.createdAt),
    )
}

/** "3 threads · 1 needs you · 1 running", or "No threads yet". */
export function threadSummary(threads: CoordinatorThread[]): string {
  if (!threads.length) return 'No threads yet'
  const count = (state: SessionState) => threads.filter(t => t.session.state === state).length
  const parts = [`${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}`]
  if (count('waiting')) parts.push(`${count('waiting')} needs you`)
  if (count('running')) parts.push(`${count('running')} running`)
  if (count('failed')) parts.push(`${count('failed')} failed`)
  return parts.join(' · ')
}

const MEMORY_PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.md$/

/** Why a memory path would be refused, or null when it's fine. */
export function memoryPathError(path: string): string | null {
  if (!path.trim()) return 'Give the file a name'
  if (!path.endsWith('.md')) return 'Memory files are Markdown: end the name with .md'
  if (path.length > 200 || !MEMORY_PATH.test(path) || path.split('/').includes('..'))
    return 'Use letters, digits, . _ - and / (no leading dot or ..)'
  return null
}
