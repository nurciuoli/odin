import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuCommandPalette } from '.'

const press = () =>
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))

describe('IuCommandPalette hotkey', () => {
  it('toggles on Ctrl+K by default', async () => {
    const w = mount(IuCommandPalette, { props: { sources: [], open: false } })
    press()
    expect(w.emitted('update:open')?.[0]).toEqual([true])
    w.unmount()
  })

  it('leaves Ctrl+K alone with hotkey=false', async () => {
    const w = mount(IuCommandPalette, { props: { sources: [], open: false, hotkey: false } })
    press()
    expect(w.emitted('update:open')).toBeUndefined()
    w.unmount()
  })
})
