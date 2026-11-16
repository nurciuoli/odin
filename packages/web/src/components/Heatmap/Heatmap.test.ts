import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Heatmap from './Heatmap.vue'
import { heatmapWeeks, levelOf, weekdayOf } from './heatmap'

// 2026-11-09 is a Monday.
const days = (n: number, start = 9) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-11-${String(start + i).padStart(2, '0')}`,
    value: i,
  }))

describe('heatmap model', () => {
  it('reads days as local dates, Monday first', () => {
    expect(weekdayOf('2026-11-09')).toBe(0)
    expect(weekdayOf('2026-11-15')).toBe(6)
  })
  it('levels are shares of the busiest day, zero only for nothing', () => {
    expect(levelOf(0, 10, 4)).toBe(0)
    expect(levelOf(1, 10, 4)).toBe(1)
    expect(levelOf(10, 10, 4)).toBe(4)
    expect(levelOf(3, 0, 4)).toBe(0)
  })
  it('pads to whole weeks of seven', () => {
    const weeks = heatmapWeeks(days(5, 11), 4) // Wed..Sun
    expect(weeks).toHaveLength(1)
    expect(weeks[0]!.slice(0, 2)).toEqual([null, null])
    expect(weeks[0]![2]!.date).toBe('2026-11-11')
    expect(heatmapWeeks(days(8), 4)).toHaveLength(2)
  })
})

describe('Heatmap', () => {
  it('titles each cell, renders a table equivalent and the summary slot', () => {
    const w = mount(Heatmap, {
      props: { days: days(7), label: 'Sessions per day' },
      slots: { default: () => '21 sessions' },
    })
    expect(w.findAll('.iu-heatmap__grid .iu-heatmap__cell')).toHaveLength(7)
    expect(w.find('[title="2026-11-15: 6"]').exists()).toBe(true)
    expect(w.find('table caption').text()).toBe('Sessions per day')
    expect(w.findAll('tbody tr')).toHaveLength(7)
    expect(w.find('figcaption').text()).toBe('21 sessions')
  })
  it('uses the format for titles and the table', () => {
    const w = mount(Heatmap, {
      props: { days: days(1), label: 'X', format: (v: number) => `${v} sessions` },
    })
    expect(w.find('td').text()).toBe('0 sessions')
  })
})
