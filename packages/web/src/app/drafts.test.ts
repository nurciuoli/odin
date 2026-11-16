import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Attachment } from '@odin/shared/api'
import { DRAFT_LIMIT, createDrafts, resetDrafts, useDrafts } from './drafts'

const attachment = (name: string) => ({
  chip: { id: name, name, size: 3, kind: 'file' as const, status: 'ready' as const },
  payload: { name, mediaType: 'text/plain', data: 'abc' } satisfies Attachment,
})

beforeEach(() => {
  localStorage.clear()
  resetDrafts()
})

describe('drafts', () => {
  it('is empty for an unknown key', () => {
    expect(createDrafts().get('s1')).toEqual({ text: '', attachments: [] })
  })

  it('keeps text and attachments in memory, text only in localStorage', () => {
    const drafts = createDrafts()
    drafts.set('s1', { text: 'hello', attachments: [attachment('a.txt')] })
    expect(drafts.get('s1')).toEqual({ text: 'hello', attachments: [attachment('a.txt')] })
    expect(localStorage.getItem('odin:draft:s1')).toBe('hello')
    // a fresh store (a reload) has the text back, not the attachments
    expect(createDrafts().get('s1')).toEqual({ text: 'hello', attachments: [] })
  })

  it('hands out copies', () => {
    const drafts = createDrafts()
    drafts.set('s1', { text: 'a', attachments: [] })
    const d = drafts.get('s1')
    d.text = 'changed'
    d.attachments.push(attachment('x'))
    expect(drafts.get('s1')).toEqual({ text: 'a', attachments: [] })
  })

  it('drops empty drafts and clears', () => {
    const drafts = createDrafts()
    drafts.set('s1', { text: 'a', attachments: [] })
    drafts.set('s1', { text: '  ', attachments: [] })
    expect(localStorage.getItem('odin:draft:s1')).toBeNull()
    expect(drafts.get('s1').text).toBe('')
    drafts.set('s2', { text: 'b', attachments: [] })
    drafts.clear('s2')
    expect(localStorage.getItem('odin:draft:s2')).toBeNull()
    expect(drafts.get('s2').text).toBe('')
  })

  it('appends as a new paragraph', () => {
    const drafts = createDrafts()
    drafts.append('s1', '> quote')
    expect(drafts.get('s1').text).toBe('> quote')
    drafts.append('s1', 'more')
    expect(drafts.get('s1').text).toBe('> quote\n\nmore')
  })

  it('keeps the 50 most recently written drafts', () => {
    const drafts = createDrafts()
    for (let i = 0; i <= DRAFT_LIMIT; i++) drafts.set(`s${i}`, { text: `t${i}`, attachments: [] })
    expect(localStorage.getItem('odin:draft:s0')).toBeNull()
    expect(localStorage.getItem(`odin:draft:s${DRAFT_LIMIT}`)).toBe(`t${DRAFT_LIMIT}`)
    expect(drafts.get('s0').text).toBe('')
    expect(drafts.get('s1').text).toBe('t1')
    // rewriting moves a draft to the front of the line
    drafts.set('s1', { text: 'again', attachments: [] })
    drafts.set('extra', { text: 'x', attachments: [] })
    expect(drafts.get('s1').text).toBe('again')
    expect(drafts.get('s2').text).toBe('')
  })

  it('survives a storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const drafts = createDrafts()
    drafts.set('s1', { text: 'kept', attachments: [] })
    expect(drafts.get('s1').text).toBe('kept')
    spy.mockRestore()
  })

  it('tells subscribers about changes to their key', () => {
    const drafts = createDrafts()
    const seen = vi.fn()
    const off = drafts.subscribe('s1', seen)
    drafts.append('s1', 'x')
    drafts.set('s2', { text: 'y', attachments: [] })
    drafts.clear('s1')
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    drafts.append('s1', 'z')
    expect(seen).toHaveBeenCalledTimes(2)
  })

  it('shares one store app-wide', () => {
    useDrafts().set('new', { text: 'n', attachments: [] })
    expect(useDrafts().get('new').text).toBe('n')
  })
})
