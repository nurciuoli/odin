// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ProjectActivityDay, Session } from '@odin/shared/api'
import {
  DEFAULT_RANGE,
  formatDuration,
  loadRange,
  median,
  mergeRate,
  percentChange,
  rangeBounds,
  saveRange,
  spanLabel,
  splitPeriods,
  totals,
} from './overview'

const day = (date: string, o: Partial<ProjectActivityDay> = {}): ProjectActivityDay => ({
  date,
  sessions: 1,
  activeMs: 60_000,
  costUsd: 0.5,
  commits: 2,
  added: 10,
  removed: 3,
  ...o,
})

describe('overview helpers', () => {
  it('remembers the range and survives broken storage', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    }
    expect(loadRange(storage)).toBe(DEFAULT_RANGE)
    saveRange('12w', storage)
    expect(loadRange(storage)).toBe('12w')
    store.set('odin.overview.range', 'forever')
    expect(loadRange(storage)).toBe(DEFAULT_RANGE)
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadRange(broken)).toBe(DEFAULT_RANGE)
    expect(() => saveRange('7d', broken)).not.toThrow()
  })

  it('splits a series into the range and the period before it', () => {
    const s = ['01', '02', '03', '04', '05'].map(d => day(`2026-11-${d}`))
    const { current, previous } = splitPeriods(s, 2)
    expect(current.map(d => d.date)).toEqual(['2026-11-04', '2026-11-05'])
    expect(previous.map(d => d.date)).toEqual(['2026-11-02', '2026-11-03'])
    expect(splitPeriods(s.slice(0, 2), 2).previous).toEqual([])
  })

  it('sums a period, keeping unknown cost and commits null', () => {
    expect(totals([day('2026-11-01'), day('2026-11-02', { costUsd: null })])).toEqual({
      sessions: 2,
      activeMs: 120_000,
      costUsd: 0.5,
      commits: 4,
      added: 20,
      removed: 6,
    })
    const plain = totals([day('2026-11-01', { commits: null, costUsd: null })])
    expect(plain.commits).toBeNull()
    expect(plain.costUsd).toBeNull()
  })

  it('computes percent change only against a non-zero previous period', () => {
    expect(percentChange(15, 10)).toBe(50)
    expect(percentChange(5, 10)).toBe(-50)
    expect(percentChange(5, 0)).toBeNull()
    expect(percentChange(null, 3)).toBeNull()
  })

  it('bounds a range on local midnights', () => {
    const now = new Date(2026, 10, 14, 15, 30).getTime()
    const { since, until } = rangeBounds(7, now)
    expect(new Date(since)).toEqual(new Date(2026, 10, 8))
    expect(new Date(until)).toEqual(new Date(2026, 10, 15))
  })

  it('labels the span', () => {
    expect(spanLabel('2026-10-16', '2026-11-14')).toBe('16 Oct to 14 Nov 2026')
    expect(spanLabel('2025-12-30', '2026-01-05')).toBe('30 Dec 2025 to 5 Jan 2026')
    expect(spanLabel(undefined, undefined)).toBe('')
  })

  it('takes medians of known values', () => {
    expect(median([3, null, 1, 2])).toBe(2)
    expect(median([1, 4])).toBe(2.5)
    expect(median([null])).toBeNull()
  })

  it('rates merges over decided PRs', () => {
    const s = (prOutcome: string | null) => ({ metrics: { prOutcome } }) as Session
    expect(
      mergeRate([s('merged'), s('merged-after-changes'), s('closed'), s('open'), s(null)]),
    ).toBe(2 / 3)
    expect(mergeRate([s('open')])).toBeNull()
  })

  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(30_000)).toBe('<1m')
    expect(formatDuration(90 * 60_000)).toBe('1h 30m')
  })
})
