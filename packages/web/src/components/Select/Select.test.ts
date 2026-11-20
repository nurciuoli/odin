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

  it('opens the list as a popover anchored to the trigger, not in the document flow', async () => {
    const md = mount(IuSelect, {
      props: { options: ['Odin', 'open-quant'], ariaLabel: 'Project' },
      attachTo: document.body,
    })
    await md.get('button').trigger('click')
    const panel = document.body.querySelector<HTMLElement>('.iu-select__panel')!
    expect(panel.getAttribute('popover')).toBe('manual')
    expect(panel.style.position).toBe('fixed')
    expect(panel.style.width).toBe(`${md.element.getBoundingClientRect().width}px`)
    md.unmount()
  })
})
