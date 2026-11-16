// Small display helpers shared by the project screens.
import type { PermissionMode, ProjectSummary, SessionState, SyncState } from '@odin/shared/api'
import type { Status } from '@/styles/status'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "just now", "5m ago", "3h ago", "2d ago", then a date. `now` is epoch ms. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((now - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const d = new Date(then)
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** First 7 characters of a version hash. */
export function shortHash(hash: string): string {
  return hash.slice(0, 7)
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** Sync state on the shared status vocabulary, with the word the user sees. */
export const SYNC_DISPLAY: Record<SyncState, { status: Status; label: string }> = {
  off: { status: 'idle', label: 'Sync off' },
  idle: { status: 'ok', label: 'Synced' },
  syncing: { status: 'running', label: 'Syncing' },
  error: { status: 'failed', label: 'Sync error' },
}

/** The one dot a project gets: a session waiting on you, then trouble, then running work, then quiet. */
export function projectStatus(p: Pick<ProjectSummary, 'sessions' | 'sync' | 'missing'>): Status {
  if (p.sessions.waiting > 0) return 'awaiting'
  if (p.sync.state === 'error' || p.missing) return 'warning'
  return p.sessions.running > 0 ? 'running' : 'idle'
}

/** A session state on the shared status vocabulary, with the word the user sees. */
export const SESSION_DISPLAY: Record<SessionState, { status: Status; label: string }> = {
  idle: { status: 'idle', label: 'Idle' },
  running: { status: 'running', label: 'Running' },
  waiting: { status: 'awaiting', label: 'Needs you' },
  ended: { status: 'ok', label: 'Ended' },
  failed: { status: 'failed', label: 'Failed' },
}

/** A date ("2026-10-31") as "31 Oct". */
export function shortDate(date: string | null): string {
  if (!date) return ''
  const d = new Date(`${date.slice(0, 10)}T00:00:00`)
  return Number.isNaN(d.getTime()) ? '' : `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** The name a harness id shows as. Codex ids share a prefix; Grok is exact; anything else reads as Claude. */
export function harnessLabel(id: string): string {
  if (id.startsWith('codex')) return 'Codex'
  if (id === 'grok') return 'Grok'
  if (id === 'opencode') return 'OpenCode'
  if (id === 'antigravity') return 'Antigravity'
  return 'Claude'
}

/** Permission modes as the user reads them. */
/** Key order is the composer's Shift+Tab cycle: bypass comes last, after the milder modes. */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Ask before edits',
  acceptEdits: 'Accept edits',
  plan: 'Plan only',
  auto: 'Auto',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
}

/** "$0.42", "<$0.01", or "" when the cost isn't known. */
export function formatCost(usd: number | null | undefined): string {
  if (usd === null || usd === undefined) return ''
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

/** 950 → "950", 12_400 → "12k", 2_100_000 → "2.1M". */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return ''
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}
