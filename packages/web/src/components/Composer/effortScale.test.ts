// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { effortTone } from './effortScale'

describe('effort tone', () => {
  it('is muted with nothing selected', () => {
    expect(effortTone(-1, 4)).toBe('auto')
    expect(effortTone(9, 4)).toBe('auto')
  })
  it('maps four levels one to one onto the ramp', () => {
    expect([0, 1, 2, 3].map(i => effortTone(i, 4))).toEqual(['cool', 'ok', 'warm', 'hot'])
  })
  it('spreads seven levels proportionally and ends hottest', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(i => effortTone(i, 7))).toEqual([
      'cool',
      'ok',
      'ok',
      'warm',
      'warm',
      'hot',
      'hot',
    ])
  })
  it('handles two levels and one level', () => {
    expect([effortTone(0, 2), effortTone(1, 2)]).toEqual(['cool', 'hot'])
    expect(effortTone(0, 1)).toBe('ok')
  })
})
