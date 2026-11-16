import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuSelect } from '.'

describe('IuSelect', () => {
  it('is md by default and takes a compact sm size', () => {
    const md = mount(IuSelect, { props: { options: ['a', 'b'], ariaLabel: 'Pick' } })
    expect(md.classes()).not.toContain('iu-select--sm')
    const sm = mount(IuSelect, { props: { options: ['a', 'b'], ariaLabel: 'Pick', size: 'sm' } })
    expect(sm.classes()).toContain('iu-select--sm')
    expect(sm.find('[role="combobox"]').attributes('aria-label')).toBe('Pick')
  })
})
