import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { IuRuneMark } from '.'

describe('IuRuneMark', () => {
  it('is decorative and sized by the prop', () => {
    const w = mount(IuRuneMark, { props: { size: 20 } })
    const svg = w.get('svg')
    expect(svg.attributes('aria-hidden')).toBe('true')
    expect(svg.attributes('width')).toBe('20')
  })
})
