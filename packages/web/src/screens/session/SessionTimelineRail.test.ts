import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionTimelineRail from './SessionTimelineRail.vue'
import { currentStep, stepWeights, type TimelineStep } from './timeline'

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
const steps = [step(1), step(2, { failed: 1, files: 2 }), step(3)]

function mountIt(current = 1, back: number | null = null) {
  return mount(SessionTimelineRail, { props: { steps, current, back }, attachTo: document.body })
}

describe('SessionTimelineRail', () => {
  it('draws one segment per step and marks the one on screen', () => {
    const w = mountIt()
    const segs = w.findAll('button.rail__seg')
    expect(segs).toHaveLength(3)
    expect(segs.map(s => s.attributes('aria-current'))).toEqual([undefined, 'step', undefined])
    expect(segs.map(s => s.attributes('tabindex'))).toEqual(['-1', '0', '-1'])
    w.unmount()
  })

  it('previews a step on hover and jumps on click', async () => {
    const w = mountIt()
    expect(w.find('.rail__peek').exists()).toBe(false)
    const segs = w.findAll('button.rail__seg')
    await segs[1]!.trigger('mouseenter')
    const peek = w.find('.rail__peek')
    expect(peek.text()).toContain('Prompt 2')
    expect(peek.text()).toContain('Reply 2')
    expect(peek.text()).toContain('2 files')
    expect(peek.text()).toContain('1 failed')
    await segs[2]!.trigger('click')
    expect(w.emitted('jump')?.[0]).toEqual([2])
    await w.find('nav').trigger('mouseleave')
    expect(w.find('.rail__peek').exists()).toBe(false)
    w.unmount()
  })

  it('offers a way back after a jump', async () => {
    const w = mountIt(2, 3)
    const back = w.find('.rail__back')
    expect(back.text()).toContain('Back to step 3')
    await back.trigger('click')
    expect(w.emitted('back')).toHaveLength(1)
    w.unmount()
    const none = mountIt()
    expect(none.find('.rail__back').exists()).toBe(false)
    none.unmount()
  })
})

describe('stepWeights', () => {
  it('weighs a step by how long it ran, and the last one by its tool calls', () => {
    const w = stepWeights([
      step(1, { at: '2026-01-01T09:00:00Z' }),
      step(2, { at: '2026-01-01T09:10:00Z' }),
      step(3, { at: '2026-01-01T09:11:00Z', tools: 8 }),
    ])
    expect(w[0]!).toBeGreaterThan(w[1]!)
    expect(w[2]!).toBeGreaterThan(w[1]! - 1)
    expect(Math.min(...w)).toBeGreaterThan(0.5)
  })
  it('caps a long gap and falls back to tool calls without timestamps', () => {
    const [long] = stepWeights([
      step(1, { at: '2026-01-01T09:00:00Z' }),
      step(2, { at: '2026-01-03T09:00:00Z' }),
    ])
    expect(long).toBeCloseTo(Math.log(31) + 0.6)
    const [busy, quiet] = stepWeights([step(1, { tools: 10 }), step(2)])
    expect(busy!).toBeGreaterThan(quiet!)
  })
})

describe('currentStep', () => {
  it('is the last message that has scrolled up to the top, or the first', () => {
    expect(currentStep([-300, -20, 400], 0)).toBe(1)
    expect(currentStep([100, 500], 0)).toBe(0)
    expect(currentStep([-5, -4, -3], 0)).toBe(2)
  })
})
