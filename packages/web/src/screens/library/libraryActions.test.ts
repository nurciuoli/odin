import { describe, expect, it } from 'vitest'
import { assetMenu, copyId } from './libraryActions'

describe('copyId', () => {
  it('adds -copy, then counts up past taken ids', () => {
    expect(copyId('pr-review', [])).toBe('pr-review-copy')
    expect(copyId('pr-review', ['pr-review-copy'])).toBe('pr-review-copy-2')
    expect(copyId('pr-review', ['pr-review-copy', 'pr-review-copy-2'])).toBe('pr-review-copy-3')
  })
  it('stays within the 64 character id limit', () => {
    const id = 'a'.repeat(64)
    const copy = copyId(id, [])
    expect(copy.length).toBeLessThanOrEqual(64)
    expect(copy.endsWith('-copy')).toBe(true)
  })
})

describe('assetMenu', () => {
  const ids = (m: ReturnType<typeof assetMenu>) => m.map(i => ('id' in i ? i.id : '-'))
  it('offers Disable for an enabled item and Enable for a disabled one', () => {
    expect(assetMenu('skill', true).find(i => 'id' in i && i.id === 'toggle')).toMatchObject({
      label: 'Disable',
    })
    expect(assetMenu('skill', false).find(i => 'id' in i && i.id === 'toggle')).toMatchObject({
      label: 'Enable',
    })
  })
  it('swaps Duplicate for Export on plugins', () => {
    expect(ids(assetMenu('plugin', true))).toContain('export')
    expect(ids(assetMenu('plugin', true))).not.toContain('duplicate')
    expect(ids(assetMenu('mcp', true))).toContain('duplicate')
  })
})
