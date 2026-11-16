import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { describe, expect, it } from 'vitest'
import ActivityStrip from './ActivityStrip.vue'
const a = {
  id: 'a',
  label: 'Review',
  kind: 'Agent',
  state: 'running',
  status: 'running' as const,
  dismissible: false,
}
const b = {
  ...a,
  id: 'b',
  label: 'Tests',
  state: 'failed',
  status: 'failed' as const,
  dismissible: true,
}
describe('ActivityStrip', () => {
  it('flies a flock beside the title while something runs, with the agents out, and keeps the counts', async () => {
    const wrapper = mount(ActivityStrip, { props: { items: [a, b], agents: 1 } })
    expect(wrapper.findAll('.iu-activity-strip__toggle .iu-flock__agent')).toHaveLength(1)
    expect(wrapper.text()).toContain('1 running · 1 failed')
    await wrapper.setProps({ items: [b], agents: 0 })
    expect(wrapper.find('.iu-flock').exists()).toBe(false)
  })
  it('returns focus to the disclosure when a focused command exits', async () => {
    const wrapper = mount(ActivityStrip, { props: { items: [a, b] }, attachTo: document.body })
    await wrapper.find('button').trigger('click')
    ;(wrapper.find('[data-activity-id="a"] button').element as HTMLElement).focus()
    await nextTick()
    await wrapper.setProps({ items: [b] })
    expect(document.activeElement).toBe(wrapper.find('.iu-activity-strip__toggle').element)
    expect(wrapper.find('[data-activity-id="a"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('discloses counts and selects/dismisses without changing focus on arrivals', async () => {
    const wrapper = mount(ActivityStrip, { props: { items: [a, b] }, attachTo: document.body })
    expect(wrapper.text()).toContain('1 running · 1 failed')
    await wrapper.find('button').trigger('click')
    const select = wrapper.find('[data-activity-id="a"] button')
    ;(select.element as HTMLElement).focus()
    await nextTick()
    await wrapper.setProps({ items: [b, a] })
    expect(
      wrapper.findAll('[data-activity-id]').map(r => r.attributes('data-activity-id')),
    ).toEqual(['a', 'b'])
    expect(document.activeElement).toBe(select.element)
    await select.trigger('click')
    expect(wrapper.emitted('select')?.[0]).toEqual(['a'])
    await wrapper.find('button[aria-label^="Dismiss"]').trigger('click')
    expect(wrapper.emitted('dismiss')?.[0]).toEqual(['b'])
    wrapper.unmount()
  })
})
