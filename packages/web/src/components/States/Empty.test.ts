import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { IuEmpty } from '.'

describe('IuEmpty proverb', () => {
  it('shows a stable proverb by default', () => {
    const a = mount(IuEmpty, { props: { title: 'No sessions yet' } })
      .get('.iu-empty__proverb')
      .text()
    const b = mount(IuEmpty, { props: { title: 'No sessions yet' } })
      .get('.iu-empty__proverb')
      .text()
    expect(a.length).toBeGreaterThan(0)
    expect(a).toBe(b)
  })
  it('takes a custom line or none', () => {
    expect(
      mount(IuEmpty, { props: { title: 'x', proverb: 'Hello' } })
        .get('.iu-empty__proverb')
        .text(),
    ).toBe('Hello')
    expect(
      mount(IuEmpty, { props: { title: 'x', proverb: false } })
        .find('.iu-empty__proverb')
        .exists(),
    ).toBe(false)
  })
})
