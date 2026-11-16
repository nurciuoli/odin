// Overview numbers: the range control, period totals and their change, medians and PR rates over sessions.
import type { ProjectActivityDay, Session } from '@odin/shared/api'

export type RangeId = '7d' | '30d' | '12w'

export const RANGES: { value: RangeId; label: string; days: number }[] = [
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '12w', label: '12 weeks', days: 84 },
]

export const DEFAULT_RANGE: RangeId = '30d'
const RANGE_KEY = 'odin.overview.range'

export const rangeDays = (id: RangeId): number => RANGES.find(r => r.value === id)?.days ?? 30

/** The remembered range; the default when storage is unavailable or holds something else. */
export function loadRange(storage: Pick<Storage, 'getItem'> | null = safeStorage()): RangeId {
  try {
    const v = storage?.getItem(RANGE_KEY)
    return RANGES.some(r => r.value === v) ? (v as RangeId) : DEFAULT_RANGE
  } catch {
    return DEFAULT_RANGE
  }
}

export function saveRange(id: RangeId, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
  try {
    storage?.setItem(RANGE_KEY, id)
  } catch {
    // private mode or a full quota: the choice lasts for this page only
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The last `days` entries and the `days` before them (shorter or empty when the series is). */
export function splitPeriods(series: ProjectActivityDay[], days: number) {
  const current = series.slice(-days)
  const previous = series.slice(Math.max(0, series.length - 2 * days), -days || undefined)
  return { current, previous: series.length > days ? previous : [] }
}

export interface PeriodTotals {
  sessions: number
  activeMs: number
  costUsd: number | null
  /** null when every day's commits are null (not a git folder). */
  commits: number | null
  added: number
  removed: number
}

export function totals(days: ProjectActivityDay[]): PeriodTotals {
  const sum = (f: (d: ProjectActivityDay) => number | null) => {
    const known = days.map(f).filter((v): v is number => typeof v === 'number')
    return known.length ? known.reduce((a, v) => a + v, 0) : null
  }
  return {
    sessions: sum(d => d.sessions) ?? 0,
    activeMs: sum(d => d.activeMs) ?? 0,
    costUsd: sum(d => d.costUsd),
    commits: sum(d => d.commits),
    added: sum(d => d.added) ?? 0,
    removed: sum(d => d.removed) ?? 0,
  }
}

/** Whole-percent change from `previous` to `current`; null when there is nothing to compare with. */
export function percentChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null
  return Math.round(((current - previous) / previous) * 100)
}

/** Local midnight `days - 1` days before `now`, and the next local midnight after `now`, as ISO strings. */
export function rangeBounds(days: number, now: number = Date.now()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const end = new Date(now)
  end.setHours(0, 0, 0, 0)
  end.setDate(end.getDate() + 1)
  return { since: start.toISOString(), until: end.toISOString() }
}

export function median(values: (number | null | undefined)[]): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  if (!v.length) return null
  v.sort((a, b) => a - b)
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2
}

/** Merged / sessions whose PR was merged or closed; null when none were. */
export function mergeRate(sessions: Pick<Session, 'metrics'>[]): number | null {
  let merged = 0
  let decided = 0
  for (const s of sessions) {
    const o = s.metrics.prOutcome
    if (o === 'merged' || o === 'merged-after-changes') merged++
    if (o === 'merged' || o === 'merged-after-changes' || o === 'closed') decided++
  }
  return decided ? merged / decided : null
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 60_000) return '<1m'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h}h ${m}m` : `${h}h`
}

/** 1234 → "1,234". */
export const formatCount = (n: number): string => n.toLocaleString('en-US')

/** "15 Oct to 14 Nov 2026" for the dates of a series (YYYY-MM-DD). */
export function spanLabel(first: string | undefined, last: string | undefined): string {
  if (!first || !last) return ''
  const d = (s: string) => {
    const [y, m, day] = s.split('-').map(Number)
    return new Date(y!, m! - 1, day!)
  }
  const a = d(first)
  const b = d(last)
  const short = (x: Date) => x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const year = (x: Date) => x.getFullYear()
  return year(a) === year(b)
    ? `${short(a)} to ${short(b)} ${year(b)}`
    : `${short(a)} ${year(a)} to ${short(b)} ${year(b)}`
}
