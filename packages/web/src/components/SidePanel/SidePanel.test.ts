import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuSidePanel } from '.'

describe('IuSidePanel', () => {
  it('draws the default header unless a variant is asked for', () => {
    const w = mount(IuSidePanel, { props: { title: 'Details' }, slots: { default: 'body' } })
    expect(w.classes()).not.toContain('iu-side-panel--compact')
    expect(w.classes()).not.toContain('iu-side-panel--column')
    w.unmount()
  })

  it('marks the compact variant (36px header, quiet divider) and keeps the title', () => {
    const w = mount(IuSidePanel, {
      props: { title: 'Details', variant: 'compact' },
      slots: { default: 'body' },
    })
    expect(w.classes()).toContain('iu-side-panel--compact')
    expect(w.classes()).not.toContain('iu-side-panel--column')
    expect(w.find('.iu-side-panel__title').text()).toBe('Details')
    w.unmount()
  })
})
