// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { diffLines } from './index'

const types = (a: string, b: string) => diffLines(a, b).flatMap(h => h.lines.map(l => l.type))

describe('diffLines', () => {
  it('returns no hunks for two empty texts', () => {
    expect(diffLines('', '')).toEqual([])
  })
  it('marks unchanged text as context with both numbers', () => {
    const [h] = diffLines('a\nb', 'a\nb')
    expect(h!.lines).toEqual([
      { type: 'context', oldNum: 1, newNum: 1, content: 'a' },
      { type: 'context', oldNum: 2, newNum: 2, content: 'b' },
    ])
  })
  it('inserts', () => {
    const [h] = diffLines('a\nc', 'a\nb\nc')
    expect(types('a\nc', 'a\nb\nc')).toEqual(['context', 'add', 'context'])
    expect(h!.lines[1]).toEqual({ type: 'add', newNum: 2, content: 'b' })
    expect(h!.lines[2]).toMatchObject({ oldNum: 2, newNum: 3 })
  })
  it('deletes', () => {
    const [h] = diffLines('a\nb\nc', 'a\nc')
    expect(h!.lines[1]).toEqual({ type: 'remove', oldNum: 2, content: 'b' })
  })
  it('shows a change as remove then add', () => {
    expect(types('a\nb\nc', 'a\nB\nc')).toEqual(['context', 'remove', 'add', 'context'])
  })
  it('handles one side empty', () => {
    expect(types('', 'x\ny')).toEqual(['add', 'add'])
    expect(types('x\ny', '')).toEqual(['remove', 'remove'])
  })
  it('ignores a trailing newline', () => {
    expect(types('a\n', 'a')).toEqual(['context'])
  })
})
