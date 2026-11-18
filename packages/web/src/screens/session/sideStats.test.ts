import { describe, expect, it } from 'vitest'
import { activeShare, cacheHitRate, changeSplit, duration, fmt, money, tokenMix } from './sideStats'

const t = { input: 200, output: 33_100, cacheRead: 7_800_000, cacheWrite: 93_000 }

describe('sideStats', () => {
  it('formats numbers, durations and money', () => {
    expect([fmt(200), fmt(33_100), fmt(7_800_000)]).toEqual(['200', '33.1k', '7.8M'])
    expect([duration(null), duration(20_000), duration(7 * 60_000), duration(93 * 60_000)]).toEqual(
      ['—', '<1m', '7m', '1h 33m'],
    )
    expect([money(2.678), money(null)]).toEqual(['$2.68', '—'])
  })
  it('splits the token mix and finds the cache hit rate', () => {
    const mix = tokenMix(t)
    expect(mix.map(m => m.kind)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite'])
    expect(mix.reduce((n, m) => n + m.pct, 0)).toBeCloseTo(100)
    expect(cacheHitRate(t)).toBeCloseTo(0.988, 3)
  })
  it('has no mix or hit rate before anything was sent', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    expect(tokenMix(zero).every(m => m.pct === 0)).toBe(true)
    expect(cacheHitRate(zero)).toBeNull()
  })
  it('splits changes and active time', () => {
    expect(changeSplit(12, 5)?.added).toBeCloseTo(70.6, 1)
    expect(changeSplit(0, 0)).toBeNull()
    expect(activeShare(7 * 60_000, 93 * 60_000)).toBeCloseTo(0.075, 3)
    expect(activeShare(null, 1)).toBeNull()
    expect(activeShare(5, 0)).toBeNull()
  })
})
