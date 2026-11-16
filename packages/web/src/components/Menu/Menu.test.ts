import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { IuMenu } from '.'

let w: VueWrapper | undefined
afterEach(() => {
  w?.unmount()
  w = undefined
})

function mountMenu(fixed: boolean) {
  const Host = defineComponent({
    setup: () => () =>
      h(
        IuMenu,
        { items: [{ id: 'a', label: 'Archive' }], fixed },
        {
          trigger: ({ toggle }: { toggle: () => void }) => h('button', { onClick: toggle }, 'More'),
        },
      ),
  })
  return mount(Host, { attachTo: document.body })
}

describe('IuMenu fixed', () => {
  it('opens a context menu at the pointer and returns keyboard focus to its link', async () => {
    w = mount(IuMenu, {
      props: { items: [{ id: 'rename', label: 'Rename' }], contextMenu: true },
      slots: { trigger: '<a href="/session">Session</a>' },
      attachTo: document.body,
    })
    const link = w.find('a')
    await link.trigger('contextmenu', { clientX: 80, clientY: 120 })
    await flushPromises()
    expect((w.find('[role="menu"]').element as HTMLElement).style.left).toBe('80px')
    expect((w.find('[role="menu"]').element as HTMLElement).style.top).toBe('120px')
    await w.find('[role="menu"]').trigger('keydown', { key: 'Escape' })
    expect(w.find('[role="menu"]').exists()).toBe(false)
    expect(document.activeElement).toBe(link.element)
    await link.trigger('keydown', { key: 'F10', shiftKey: true })
    await flushPromises()
    expect(w.find('[role="menu"]').exists()).toBe(true)
    await w.find('[role="menu"]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('select')).toEqual([['rename']])
  })

  it('positions the panel against the viewport and closes when something scrolls', async () => {
    w = mountMenu(true)
    await w.find('button').trigger('click')
    await flushPromises()
    const panel = w.find('[role="menu"]')
    expect((panel.element as HTMLElement).style.position).toBe('fixed')
    window.dispatchEvent(new Event('scroll'))
    await flushPromises()
    expect(w.find('[role="menu"]').exists()).toBe(false)
  })

  it('stays absolutely placed by default', async () => {
    w = mountMenu(false)
    await w.find('button').trigger('click')
    await flushPromises()
    expect((w.find('[role="menu"]').element as HTMLElement).style.position).toBe('')
  })
})
