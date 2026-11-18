// Numbers behind the Details panel's quiet visualisations: token mix, cache hit rate, change split. Pure, so the
// component stays markup and these stay testable.
import type { TokenUsage } from '@odin/shared/api'

export function fmt(n: number): string {
  return n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${+(n / 1000).toFixed(1)}k`
      : String(n)
}

export function duration(ms: number | null): string {
  if (ms === null) return '—'
  const m = Math.round(ms / 60_000)
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export function money(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`
}

export type TokenKind = keyof TokenUsage
export const TOKEN_LABEL: Record<TokenKind, string> = {
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
}
const ORDER: TokenKind[] = ['input', 'output', 'cacheRead', 'cacheWrite']

/** Each token kind's share (0–100) of everything the session moved. */
export function tokenMix(t: TokenUsage): { kind: TokenKind; value: number; pct: number }[] {
  const total = ORDER.reduce((n, k) => n + t[k], 0)
  return ORDER.map(kind => ({
    kind,
    value: t[kind],
    pct: total > 0 ? (t[kind] / total) * 100 : 0,
  }))
}

/** Share (0–1) of prompt tokens served from the cache; null when nothing was sent. */
export function cacheHitRate(t: TokenUsage): number | null {
  const prompt = t.input + t.cacheRead + t.cacheWrite
  return prompt > 0 ? t.cacheRead / prompt : null
}

/** Added vs removed as a split (0–100) of one bar; null when nothing changed. */
export function changeSplit(
  added: number,
  removed: number,
): { added: number; removed: number } | null {
  const total = added + removed
  return total > 0 ? { added: (added / total) * 100, removed: (removed / total) * 100 } : null
}

/** Share (0–1) of wall time spent working; null without both numbers. */
export function activeShare(activeMs: number | null, wallMs: number | null): number | null {
  return activeMs !== null && wallMs !== null && wallMs > 0 ? Math.min(1, activeMs / wallMs) : null
}
