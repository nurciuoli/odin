import { beforeEach, describe, expect, it } from 'vitest'
import { loadRecents, pushRecent, RECENT_LIMIT } from './paletteRecents'

beforeEach(() => localStorage.clear())

describe('paletteRecents', () => {
  it('keeps the newest first and moves a repeat to the front', () => {
    pushRecent({ id: 'a', label: 'A' })
    pushRecent({ id: 'b', label: 'B' })
    pushRecent({ id: 'a', label: 'A' })
    expect(loadRecents().map(e => e.id)).toEqual(['a', 'b'])
  })
  it('caps the list', () => {
    for (let i = 0; i < RECENT_LIMIT + 3; i++) pushRecent({ id: String(i), label: String(i) })
    expect(loadRecents()).toHaveLength(RECENT_LIMIT)
    expect(loadRecents()[0]!.id).toBe(String(RECENT_LIMIT + 2))
  })
  it('ignores stored junk', () => {
    localStorage.setItem('odin:palette-recent', '{"x":1}')
    expect(loadRecents()).toEqual([])
    localStorage.setItem('odin:palette-recent', 'not json')
    expect(loadRecents()).toEqual([])
  })
})
