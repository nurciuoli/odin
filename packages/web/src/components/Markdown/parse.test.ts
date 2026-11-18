import { describe, expect, it } from 'vitest'
import { parseMarkdown } from './parse'

describe('parseMarkdown document mode', () => {
  const src =
    '# Title\n\n## Start here\n\n- `a.md`: first\n  wrapped line\n- `b.md`: second\n\nSome text\nwrapped.'
  it('keeps h1-h6 and reflows soft line breaks', () => {
    const blocks = parseMarkdown(src, { document: true })
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 })
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 2 })
    const list = blocks[2]
    expect(list.kind).toBe('list')
    if (list.kind === 'list') {
      expect(list.items).toHaveLength(2)
      expect(list.items[0].children.some(c => c.kind === 'break')).toBe(false)
      expect(list.items[0].children[0]).toEqual({ kind: 'code', value: 'a.md' })
    }
    const para = blocks[3]
    expect(para.kind === 'paragraph' && para.children.some(c => c.kind === 'break')).toBe(false)
  })
  it('keeps chat behaviour by default', () => {
    const blocks = parseMarkdown(src)
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 3 })
    const para = blocks[3]
    expect(para.kind === 'paragraph' && para.children.some(c => c.kind === 'break')).toBe(true)
  })
})
