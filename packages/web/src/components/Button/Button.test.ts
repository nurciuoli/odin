import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { IuButton } from '.'

describe('IuButton', () => {
  it('is type="button" by default, so it never submits a form it sits in', async () => {
    const onSubmit = vi.fn()
    const Form = defineComponent({
      setup: () => () =>
        h('form', { onSubmit: (e: Event) => (e.preventDefault(), onSubmit()) }, [
          h(IuButton, null, () => 'Cancel'),
          h(IuButton, { type: 'submit' }, () => 'Save'),
        ]),
    })
    const w = mount(Form, { attachTo: document.body })
    const [cancel, save] = w.findAll('button')
    expect(cancel!.attributes('type')).toBe('button')
    expect(save!.attributes('type')).toBe('submit')
    await cancel!.trigger('click')
    expect(onSubmit).not.toHaveBeenCalled()
    ;(save!.element as HTMLButtonElement).click()
    expect(onSubmit).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('puts no type on other elements', () => {
    const w = mount(IuButton, {
      props: { as: 'a' },
      attrs: { href: '#x' },
      slots: { default: 'Go' },
    })
    expect(w.attributes('type')).toBeUndefined()
  })
})
