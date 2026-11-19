import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionTimeline from './SessionTimeline.vue'
import type { TimelineStep } from './timeline'

const step = (n: number, o: Partial<TimelineStep> = {}): TimelineStep => ({
  id: `u${n}`,
  n,
  prompt: `Prompt ${n}`,
  at: null,
  reply: `Reply ${n}`,
  tools: 0,
  files: 0,
  failed: 0,
  agents: 0,
  ...o,
})
const steps = [step(1), step(2, { failed: 1, files: 2 }), step(3, { agents: 1 })]

function mountIt(selected = 1) {
  return mount(SessionTimeline, {
    props: { steps, modelValue: selected, 'onUpdate:modelValue': () => {} },
    attachTo: document.body,
  })
}

describe('SessionTimeline', () => {
  it('lists the steps and marks the selected one', () => {
    const w = mountIt()
    const rows = w.findAll('[role="option"]')
    expect(rows).toHaveLength(3)
    expect(rows.map(r => r.attributes('aria-selected'))).toEqual(['false', 'true', 'false'])
    expect(rows[1]!.text()).toContain('1 failed')
    expect(rows[1]!.text()).toContain('2 files')
    expect(rows[2]!.text()).toContain('agent')
    w.unmount()
  })

  it('moves with the arrow keys and stops at the ends', async () => {
    const w = mountIt(0)
    const nav = w.find('nav')
    await nav.trigger('keydown', { key: 'ArrowUp' })
    expect(w.emitted('update:modelValue')).toBeUndefined()
    await nav.trigger('keydown', { key: 'ArrowDown' })
    expect(w.emitted('update:modelValue')?.[0]).toEqual([1])
    await nav.trigger('keydown', { key: 'End' })
    expect(w.emitted('update:modelValue')?.[1]).toEqual([2])
    w.unmount()
  })

  it('stays on Enter, goes back on Escape and copies on c and r', async () => {
    const w = mountIt()
    const nav = w.find('nav')
    await nav.trigger('keydown', { key: 'Enter' })
    await nav.trigger('keydown', { key: 'Escape' })
    await nav.trigger('keydown', { key: 'c' })
    await nav.trigger('keydown', { key: 'r' })
    expect(w.emitted('commit')).toHaveLength(1)
    expect(w.emitted('cancel')).toHaveLength(1)
    expect(w.emitted('copy')?.map(a => [a[0], (a[1] as TimelineStep).n])).toEqual([
      ['prompt', 2],
      ['reply', 2],
    ])
    w.unmount()
  })

  it('leaves keys with a modifier to the app', async () => {
    const w = mountIt()
    await w.find('nav').trigger('keydown', { key: 'c', metaKey: true })
    expect(w.emitted('copy')).toBeUndefined()
    w.unmount()
  })

  it('only offers a reply copy when Claude has replied', () => {
    const w = mount(SessionTimeline, {
      props: {
        steps: [step(1, { reply: '' }), step(2)],
        modelValue: 0,
        'onUpdate:modelValue': () => {},
      },
    })
    const buttons = w.findAll('button')
    expect(buttons[1]!.attributes('disabled')).toBeDefined()
    w.unmount()
  })
})
