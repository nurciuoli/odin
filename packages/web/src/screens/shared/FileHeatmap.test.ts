import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import FileHeatmap from './FileHeatmap.vue'

describe('FileHeatmap', () => {
  afterEach(() => vi.restoreAllMocks())

  it('renders one named button per item and emits the id on click', async () => {
    // jsdom has no layout, so give the map a width.
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300)
    const w = mount(FileHeatmap, {
      props: {
        label: 'Changed files',
        items: [
          { id: 'a.ts', label: 'a.ts', value: 10, added: 10, title: 'a.ts · +10' },
          { id: 'b.ts', label: 'b.ts', value: 2, removed: 2 },
        ],
      },
      attachTo: document.body,
    })
    await w.vm.$nextTick()
    await w.vm.$nextTick()
    const buttons = w.findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.attributes('aria-label')).toBe('a.ts · +10')
    await buttons[1]!.trigger('click')
    expect(w.emitted('select')).toEqual([['b.ts']])
    w.unmount()
  })
})
