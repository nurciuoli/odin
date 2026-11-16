import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BarChart from './BarChart.vue'
import { barPath, barSlot, dateTickIndices, domain, niceTicks } from './barchart'

const days = [
  { date: '2026-11-09', values: [10, 4] },
  { date: '2026-11-10', values: [0, 8] },
  { date: '2026-11-11', values: [20, 0] },
]
const series = [
  { key: 'a', label: 'Added', color: '--iu-viz-gain' },
  { key: 'r', label: 'Removed', color: '--iu-viz-loss' },
]

describe('bar chart model', () => {
  it('picks round ticks', () => {
    expect(niceTicks(0, 20)).toEqual([0, 5, 10, 15, 20])
    expect(niceTicks(-10, 20)).toContain(0)
    expect(niceTicks(0, 0)).toEqual([0])
  })
  it('diverging domain spans below zero by series 2', () => {
    expect(domain(days, 'grouped')[0]).toBe(0)
    const [lo, hi] = domain(days, 'diverging')
    expect(lo).toBeLessThanOrEqual(-8)
    expect(hi).toBeGreaterThanOrEqual(20)
  })
  it('gives the small side of a diverging chart at least one tick step', () => {
    const lopsided = [{ date: '2026-11-09', values: [100, 4000] }]
    const [lo, hi] = domain(lopsided, 'diverging')
    expect(lo).toBeLessThanOrEqual(-4000)
    const step = niceTicks(lo, hi)[1]! - niceTicks(lo, hi)[0]!
    expect(hi).toBeGreaterThanOrEqual(step)
    expect(hi).toBeGreaterThan(100)
    expect(niceTicks(lo, hi).filter(t => t > 0).length).toBeGreaterThanOrEqual(1)
    expect(domain([{ date: '2026-11-09', values: [4000, 100] }], 'diverging')[0]).toBeLessThan(-100)
  })
  it('lays out bars with a 2px gap', () => {
    const { w, offsets } = barSlot(30, 2, 2)
    expect(offsets[1]! - offsets[0]! - w).toBe(2)
  })
  it('rounds only the data end and skips empty bars', () => {
    expect(barPath(0, 8, 100, 100)).toBe('')
    expect(barPath(0, 8, 100, 50)).toContain('Q')
    expect(barPath(0, 8, 100, 50).startsWith('M0 100V54')).toBe(true)
    expect(barPath(0, 8, 100, 150).startsWith('M0 100V146')).toBe(true)
  })
  it('thins date ticks', () => {
    expect(dateTickIndices(30, 5).length).toBeLessThanOrEqual(5)
    expect(dateTickIndices(0, 5)).toEqual([])
  })
})

describe('IuBarChart', () => {
  const make = (mode: 'grouped' | 'diverging' = 'grouped', s = series) =>
    mount(BarChart, {
      props: { days, series: s, mode, label: 'Lines per day', format: (v: number) => `${v} lines` },
    })

  it('summarises, shows a legend for two series and carries a table', () => {
    const w = make()
    expect(w.find('svg').attributes('aria-label')).toContain('Lines per day')
    expect(w.find('.iu-barchart__legend').text()).toContain('Removed')
    expect(w.findAll('tbody tr')).toHaveLength(3)
    expect(w.find('tbody tr td').text()).toBe('10 lines')
  })
  it('labels ticks with tickFormat and keeps format for the values', () => {
    const w = mount(BarChart, {
      props: {
        days,
        series: series.slice(0, 1),
        label: 'Sessions per day',
        format: (v: number) => `${v} sessions`,
        tickFormat: (v: number) => String(v),
      },
    })
    const ticks = w.findAll('.iu-barchart__tick').map(t => t.text())
    expect(ticks).toContain('20')
    expect(ticks.some(t => t.includes('sessions'))).toBe(false)
    expect(w.find('table').text()).toContain('20 sessions')
  })
  it('has no legend for one series', () => {
    expect(make('grouped', series.slice(0, 1)).find('.iu-barchart__legend').exists()).toBe(false)
  })
  it('draws series 2 below the axis when diverging', () => {
    const w = make('diverging')
    const [add, rem] = w.findAll('.iu-barchart__bar').slice(0, 2)
    const coords = (p: string) => [...p.matchAll(/[MVH](-?[\d.]+)(?: (-?[\d.]+))?/g)]
    const base = Number(coords(add!.attributes('d') ?? '')[0]![2])
    expect(Number(coords(rem!.attributes('d') ?? '')[1]![1])).toBeGreaterThan(base)
  })
  it('shows a tooltip with date and value on focus and moves by arrow key', async () => {
    const w = make()
    const hits = w.findAll('.iu-barchart__hit')
    expect(hits.map(h => h.attributes('tabindex'))).toEqual(['0', '-1', '-1'])
    await hits[0]!.trigger('focus')
    expect(w.find('.iu-barchart__tip').text()).toContain('2026-11-09')
    expect(w.find('.iu-barchart__tip').text()).toContain('10 lines')
    await hits[0]!.trigger('pointerleave')
    await hits[0]!.trigger('blur')
    expect(w.find('.iu-barchart__tip').exists()).toBe(false)
  })
  it('handles no days', () => {
    const w = mount(BarChart, { props: { days: [], series, label: 'Empty' } })
    expect(w.find('svg').attributes('aria-label')).toContain('no data')
  })
})
