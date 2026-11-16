// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComposerCommand } from '@/components/Chat/types'
import {
  filterCommands,
  insertChoice,
  insertCommand,
  insertMention,
  latestDebounced,
  mentionToken,
  slashToken,
} from './composerMenus'

const cmd = (name: string, extra: Partial<ComposerCommand> = {}): ComposerCommand => ({
  id: name,
  name,
  ...extra,
})

describe('slashToken', () => {
  it('is active only while the caret is inside the first token', () => {
    expect(slashToken('/re', 3)).toEqual({ query: 're', start: 0, end: 3 })
    expect(slashToken('/review ', 8)).toBeNull()
    expect(slashToken('hello /re', 9)).toBeNull()
    expect(slashToken('/re', 0)).toBeNull()
  })
})

describe('filterCommands', () => {
  const list = [
    cmd('clear', { aliases: ['reset', 'new'], group: 'Odin' }),
    cmd('compact', { group: 'Built-in' }),
    cmd('review', { group: 'Built-in' }),
    cmd('pr-review', { group: 'Custom' }),
  ]
  it('matches names and aliases by prefix, keeping groups together', () => {
    expect(filterCommands(list, 'c').map(c => c.name)).toEqual(['clear', 'compact'])
    expect(filterCommands(list, 'reset').map(c => c.name)).toEqual(['clear'])
    expect(filterCommands(list, 'RE').map(c => c.name)).toEqual(['clear', 'review', 'pr-review'])
    expect(filterCommands(list, '')).toHaveLength(4)
    expect(filterCommands(list, 'zzz')).toEqual([])
  })
})

describe('insertCommand / insertChoice', () => {
  it('replaces the typed token and keeps what follows', () => {
    expect(insertCommand('/re fix it', { query: 're', start: 0, end: 3 }, cmd('review'))).toEqual({
      text: '/review fix it',
      caret: 8,
    })
  })
  it('gives a hint only while an argument is still expected', () => {
    const review = cmd('review')
    expect(insertChoice(review, { label: 'Base', insert: 'branch ', hint: '<branch>' })).toEqual({
      text: '/review branch ',
      caret: 15,
      hint: '<branch>',
    })
    expect(insertChoice(review, { label: 'Uncommitted', insert: '' }).hint).toBeNull()
    expect(insertChoice(review, { label: 'X', insert: 'all', hint: 'n/a' }).hint).toBeNull()
  })
})

describe('mentionToken / insertMention', () => {
  it('opens at the start or after whitespace only', () => {
    expect(mentionToken('@src', 4)).toEqual({ query: 'src', start: 0, end: 4 })
    expect(mentionToken('look at @sr', 11)).toEqual({ query: 'sr', start: 8, end: 11 })
    expect(mentionToken('me@example', 10)).toBeNull()
    expect(mentionToken('@src done', 9)).toBeNull()
    expect(mentionToken('@', 1)).toEqual({ query: '', start: 0, end: 1 })
  })
  it('covers the rest of the word when the caret is mid-token', () => {
    expect(mentionToken('@srcx y', 2)).toEqual({ query: 'srcx', start: 0, end: 5 })
  })
  it('inserts files with a trailing space and directories with a slash', () => {
    const t = mentionToken('see @ex', 7)!
    expect(insertMention('see @ex', t, { path: 'src/example.ts', kind: 'file' })).toEqual({
      text: 'see @src/example.ts ',
      caret: 20,
    })
    expect(insertMention('see @ex', t, { path: 'src', kind: 'directory' })).toEqual({
      text: 'see @src/',
      caret: 9,
    })
    const mid = mentionToken('@ex now', 3)!
    expect(insertMention('@ex now', mid, { path: 'a.ts', kind: 'file' })).toEqual({
      text: '@a.ts now',
      caret: 6,
    })
  })
})

describe('latestDebounced', () => {
  afterEach(() => vi.useRealTimers())
  it('debounces and drops stale responses', async () => {
    vi.useFakeTimers()
    const resolvers: (() => void)[] = []
    const run = vi.fn((q: string) => new Promise<string>(res => resolvers.push(() => res(q))))
    const seen: string[] = []
    const d = latestDebounced(run, 120, r => seen.push(r))
    d.call('a')
    d.call('ab')
    await vi.advanceTimersByTimeAsync(120)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenLastCalledWith('ab')
    d.call('abc')
    await vi.advanceTimersByTimeAsync(120)
    resolvers[1]!()
    resolvers[0]!()
    await vi.runAllTimersAsync()
    expect(seen).toEqual(['abc'])
  })
})
