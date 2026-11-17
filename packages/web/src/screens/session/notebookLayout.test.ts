import { describe, expect, it } from 'vitest'
import {
  OUTLINE_MIN_WIDTH,
  formatDuration,
  outlineEntries,
  showOutline,
  visibleToolbarCount,
} from './notebookLayout'

const cell = (id: string, kind: 'code' | 'markdown', source: string) => ({
  id,
  kind,
  source,
  outputs: [],
  executionCount: null,
})

describe('notebook layout thresholds', () => {
  it('shows the outline from the pane width up, not below', () => {
    expect(showOutline(OUTLINE_MIN_WIDTH - 1)).toBe(false)
    expect(showOutline(OUTLINE_MIN_WIDTH)).toBe(true)
  })
  it('keeps every button when they fit, with no menu', () => {
    expect(visibleToolbarCount(400, [80, 80, 80], 8, 28)).toBe(3)
    expect(visibleToolbarCount(256, [80, 80, 80], 8, 28)).toBe(3)
  })
  it('folds from the end as the pane narrows, leaving room for the menu', () => {
    expect(visibleToolbarCount(255, [80, 80, 80], 8, 28)).toBe(2)
    expect(visibleToolbarCount(160, [80, 80, 80], 8, 28)).toBe(1)
    expect(visibleToolbarCount(100, [80, 80, 80], 8, 28)).toBe(0)
    expect(visibleToolbarCount(0, [80, 80, 80], 8, 28)).toBe(0)
  })
  it('builds an outline of headings and code cells, skipping fenced code', () => {
    const entries = outlineEntries([
      cell('a', 'markdown', '# Title\ntext\n```\n# not a heading\n```\n## Part'),
      cell('b', 'code', '\nimport pandas'),
      cell('c', 'code', ''),
    ])
    expect(entries.map(e => [e.kind, e.level, e.text, e.cellId])).toEqual([
      ['heading', 1, 'Title', 'a'],
      ['heading', 2, 'Part', 'a'],
      ['cell', 0, 'import pandas', 'b'],
      ['cell', 0, 'Empty cell', 'c'],
    ])
  })
  it('formats run times', () => {
    expect(formatDuration(400)).toBe('0.4s')
    expect(formatDuration(14_000)).toBe('14s')
    expect(formatDuration(125_000)).toBe('2m 05s')
  })
})
