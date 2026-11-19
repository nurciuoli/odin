// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { statusLabel } from '@/styles/status'
import {
  formatCost,
  formatTokens,
  harnessLabel,
  needsYouText,
  needYouCount,
  plural,
  projectStatus,
  relativeTime,
  SESSION_DISPLAY,
  shortDate,
  shortHash,
} from './format'

const NOW = Date.parse('2026-10-17T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('format', () => {
  it('relativeTime', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now')
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe('5m ago')
    expect(relativeTime(ago(3 * 3_600_000), NOW)).toBe('3h ago')
    expect(relativeTime(ago(2 * 86_400_000), NOW)).toBe('2d ago')
    expect(relativeTime('garbage', NOW)).toBe('')
  })

  it('shortHash, plural, shortDate', () => {
    expect(shortHash('abcdef0123456789')).toBe('abcdef0')
    expect(plural(1, 'sprint')).toBe('1 sprint')
    expect(plural(2, 'sprint')).toBe('2 sprints')
    expect(shortDate('2026-10-31')).toBe('31 Oct')
    expect(shortDate(null)).toBe('')
  })

  it('projectStatus: waiting first, then trouble, then running', () => {
    const ok = { state: 'idle' as const, lastSyncAt: null, error: null }
    const n = (running: number, waiting = 0) => ({ running, waiting, total: running + waiting })
    expect(projectStatus({ sessions: n(0), sync: ok, missing: false })).toBe('idle')
    expect(projectStatus({ sessions: n(2), sync: ok, missing: false })).toBe('running')
    expect(projectStatus({ sessions: n(2), sync: { ...ok, state: 'error' }, missing: false })).toBe(
      'warning',
    )
    expect(projectStatus({ sessions: n(0), sync: ok, missing: true })).toBe('warning')
    expect(
      projectStatus({ sessions: n(1, 1), sync: { ...ok, state: 'error' }, missing: false }),
    ).toBe('awaiting')
  })

  it('SESSION_DISPLAY maps waiting to awaiting, never colour-only', () => {
    expect(SESSION_DISPLAY.waiting).toMatchObject({ status: 'awaiting', label: 'Needs you' })
    expect(SESSION_DISPLAY.ended).toMatchObject({ status: 'ok', label: 'Done' })
  })

  it('SESSION_DISPLAY words come from statusLabel, so a state is named once', () => {
    for (const d of Object.values(SESSION_DISPLAY))
      expect(d.label.toLowerCase()).toBe(statusLabel[d.status])
  })

  it('needsYouText and needYouCount speak the same words', () => {
    expect(needsYouText('permission')).toBe('Needs you · permission')
    expect(needsYouText('question')).toBe('Needs you · answer')
    expect(needsYouText(null)).toBe('Needs you')
    expect(needYouCount(1)).toBe('1 session needs you')
    expect(needYouCount(3)).toBe('3 sessions need you')
  })

  it('harnessLabel names Codex by prefix, Grok exactly, and Claude otherwise', () => {
    expect(harnessLabel('codex')).toBe('Codex')
    expect(harnessLabel('codex-wsl')).toBe('Codex')
    expect(harnessLabel('grok')).toBe('Grok')
    expect(harnessLabel('opencode')).toBe('OpenCode')
    expect(harnessLabel('antigravity')).toBe('Antigravity')
    expect(harnessLabel('claude')).toBe('Claude')
    expect(harnessLabel('grok-wsl')).toBe('Claude')
    expect(harnessLabel('')).toBe('Claude')
  })

  it('formatCost and formatTokens', () => {
    expect(formatCost(null)).toBe('')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(0.4234)).toBe('$0.42')
    expect(formatTokens(null)).toBe('')
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1500)).toBe('1.5k')
    expect(formatTokens(12_400)).toBe('12k')
    expect(formatTokens(2_100_000)).toBe('2.1M')
  })
})
