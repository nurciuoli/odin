import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { IuHoverCard } from '.'

let w: VueWrapper | undefined
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  w?.unmount()
  w = undefined
  // let the shared "warm" window lapse so each test starts cold
  vi.advanceTimersByTime(1000)
  vi.useRealTimers()
})

function setup() {
  w = mount(IuHoverCard, {
    props: { openDelay: 450, closeDelay: 200 },
    slots: { default: '<a href="#x" id="t">Odin</a>', card: '<p id="body">Overview</p>' },
    attachTo: document.body,
  })
  return w.find('span').element as HTMLElement
}
function pointer(el: Element, type: string, pointerType = 'mouse') {
  el.dispatchEvent(Object.assign(new Event(type), { pointerType }))
}
const card = () => document.body.querySelector('.iu-hovercard')

describe('IuHoverCard', () => {
  it('opens only after the open delay, and describes the trigger while open', async () => {
    const root = setup()
    pointer(root, 'pointerenter')
    vi.advanceTimersByTime(400)
    await vi.advanceTimersByTimeAsync(0)
    expect(card()).toBeNull()
    await vi.advanceTimersByTimeAsync(60)
    expect(card()?.getAttribute('role')).toBe('tooltip')
    expect(document.getElementById('t')?.getAttribute('aria-describedby')).toBe(card()?.id)
  })

  it('stays shut when the pointer leaves before the delay', async () => {
    const root = setup()
    pointer(root, 'pointerenter')
    await vi.advanceTimersByTimeAsync(200)
    pointer(root, 'pointerleave')
    await vi.advanceTimersByTimeAsync(600)
    expect(card()).toBeNull()
  })

  it('closes after the close delay, and not while the pointer is on the card', async () => {
    const root = setup()
    pointer(root, 'pointerenter')
    await vi.advanceTimersByTimeAsync(500)
    pointer(root, 'pointerleave')
    await vi.advanceTimersByTimeAsync(100)
    pointer(card()!, 'pointerenter')
    await vi.advanceTimersByTimeAsync(500)
    expect(card()).not.toBeNull()
    pointer(card()!, 'pointerleave')
    await vi.advanceTimersByTimeAsync(250)
    expect(card()).toBeNull()
    expect(document.getElementById('t')?.hasAttribute('aria-describedby')).toBe(false)
  })

  it('ignores touch pointers', async () => {
    const root = setup()
    pointer(root, 'pointerenter', 'touch')
    await vi.advanceTimersByTimeAsync(1000)
    expect(card()).toBeNull()
  })

  it('closes on Escape and stays closed until the pointer leaves', async () => {
    const root = setup()
    pointer(root, 'pointerenter')
    await vi.advanceTimersByTimeAsync(500)
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vi.advanceTimersByTimeAsync(0)
    expect(card()).toBeNull()
    pointer(root, 'pointerenter')
    await vi.advanceTimersByTimeAsync(1000)
    expect(card()).toBeNull()
    pointer(root, 'pointerleave')
    pointer(root, 'pointerenter')
    await vi.advanceTimersByTimeAsync(1000)
    expect(card()).not.toBeNull()
  })

  it('closes when the trigger is pressed', async () => {
    const root = setup()
    pointer(root, 'pointerenter')
    await vi.advanceTimersByTimeAsync(500)
    pointer(root, 'pointerdown')
    await vi.advanceTimersByTimeAsync(0)
    expect(card()).toBeNull()
  })

  it('opens the next card at once while another is open', async () => {
    const root = setup()
    pointer(root, 'pointerenter')
    await vi.advanceTimersByTimeAsync(500)
    const second = mount(IuHoverCard, {
      slots: { default: '<a href="#y">Rick</a>', card: '<p>Other</p>' },
      attachTo: document.body,
    })
    pointer(second.find('span').element, 'pointerenter')
    await vi.advanceTimersByTimeAsync(50)
    expect(document.body.querySelectorAll('.iu-hovercard')).toHaveLength(1)
    expect(card()?.textContent).toContain('Other')
    second.unmount()
  })
})
