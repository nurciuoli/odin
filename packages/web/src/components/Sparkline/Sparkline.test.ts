import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Sparkline from './Sparkline.vue'
import { sparkPath } from './sparkline'

describe('sparkPath', () => {
  it('puts the max at the top and the min at the bottom', () => {
    expect(sparkPath([0, 10], 100, 20, 0).line).toBe('M0 20 L100 0')
  })
  it('draws flat and single series mid-height, and nothing for none', () => {
    expect(sparkPath([3, 3], 100, 20, 0).line).toBe('M0 10 L100 10')
    expect(sparkPath([5], 100, 20, 0).line).toBe('M0 10 L50 10')
    expect(sparkPath([], 100, 20).line).toBe('')
  })
  it('closes the area along the bottom', () => {
    expect(sparkPath([0, 10], 100, 20, 0).area).toBe('M0 20 L100 0 L100 20 L0 20 Z')
  })
})

describe('Sparkline', () => {
  it('names min, max and last', () => {
    const w = mount(Sparkline, { props: { values: [2, 0, 5, 3], label: 'Sessions' } })
    expect(w.attributes('aria-label')).toBe('Sessions: min 0, max 5, last 3')
    expect(w.attributes('role')).toBe('img')
  })
  it('says when there is no data and draws the area only when asked', () => {
    expect(mount(Sparkline, { props: { values: [], label: 'X' } }).attributes('aria-label')).toBe(
      'X: no data',
    )
    const w = mount(Sparkline, { props: { values: [1, 2], label: 'X', area: true } })
    expect(w.find('.iu-sparkline__area').exists()).toBe(true)
  })
})
