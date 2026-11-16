import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NativeForm from './NativeForm.vue'
describe('native forms', () => {
  it('submits typed values without moving focus and blocks invalid constraints', async () => {
    const focus = document.createElement('button')
    document.body.append(focus)
    focus.focus()
    const wrapper = mount(NativeForm, {
      attachTo: document.body,
      props: {
        form: {
          title: 'Confirm',
          fields: [
            { key: 'count', type: 'integer', required: true, minimum: 1 },
            { key: 'enabled', type: 'boolean', default: false },
          ],
        },
      },
    })
    expect(document.activeElement).toBe(focus)
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('answer')).toBeUndefined()
    await wrapper.find('input[type="number"]').setValue('3')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('answer')).toEqual([[{ count: 3, enabled: false }]])
    wrapper.unmount()
    focus.remove()
  })
  it('does not expose executable external links and supports dismissal', async () => {
    const wrapper = mount(NativeForm, {
      props: {
        form: {
          title: 'External',
          fields: [{ key: 'link', type: 'external', url: 'javascript:alert(1)' }],
        },
      },
    })
    expect(wrapper.find('a').exists()).toBe(false)
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Dismiss form')!
      .trigger('click')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
  })
})
