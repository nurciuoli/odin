import { describe, expect, it } from 'vitest'
import { fuzzyFilter, fuzzyMatch } from './fuzzy'

describe('fuzzyMatch', () => {
  it('matches an in-order subsequence and reports the characters', () => {
    expect(fuzzyMatch('Fix flaky tests', 'fft')?.indices).toEqual([0, 4, 10])
  })
  it('rejects text that lacks a letter or has them out of order', () => {
    expect(fuzzyMatch('palette', 'z')).toBeNull()
    expect(fuzzyMatch('abc', 'cba')).toBeNull()
  })
  it('needs every word, in any order', () => {
    expect(fuzzyMatch('Open the Library', 'lib open')).not.toBeNull()
    expect(fuzzyMatch('Open the Library', 'open zebra')).toBeNull()
  })
  it('ranks a prefix and consecutive run above a scattered match', () => {
    const rows = fuzzyFilter(['a big old library', 'library', 'lab rinse bar y'], 'lib', s => s)
    expect(rows[0]!.item).toBe('library')
  })
  it('prefers word starts: "ns" finds New session over Insane', () => {
    const rows = fuzzyFilter(['Insane', 'New session'], 'ns', s => s)
    expect(rows[0]!.item).toBe('New session')
  })
  it('drops matches scattered across a long text, but keeps acronyms', () => {
    expect(fuzzyMatch('apps/web/src/routes/shipment.tsx', 'sess')).toBeNull()
    expect(fuzzyMatch('Fix flaky tests', 'fft')).not.toBeNull()
  })
  it('matches an empty query to everything with no highlights', () => {
    expect(fuzzyMatch('x', '  ')).toEqual({ score: 0, indices: [] })
  })
})
