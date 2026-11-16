import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import IuFlock from '@/components/Spinner/Flock.vue'
import IuRail from './Rail.vue'
import type { RailStepView } from './types'

const step = (id: string, patch: Partial<RailStepView> = {}): RailStepView => ({
  id,
  kind: 'tool',
  status: 'ok',
  verb: { live: 'Reading', done: 'Read' },
  target: `${id}.ts`,
  ...patch,
})

const mountRail = (steps: RailStepView[], props: Record<string, unknown> = {}) =>
  mount(IuRail, {
    props: { steps, label: 'Worked for 5s', live: false, ...props },
    slots: { body: '<p class="body-content">body</p>' },
    attachTo: document.body,
  })

describe('IuRail', () => {
  it('has a summary toggle with aria-expanded once the run is not live', async () => {
    const w = mountRail([step('a'), step('b')], { live: true })
    expect(w.find('.iu-rail__sum').exists()).toBe(false)
    await w.setProps({ live: false })
    const sum = w.find('.iu-rail__sum')
    expect(sum.attributes('aria-expanded')).toBe('true')
    expect(sum.find('.iu-rail__dots').attributes('aria-hidden')).toBe('true')
    expect(sum.text()).toContain('Worked for 5s')
    await sum.trigger('click')
    expect(w.find('.iu-rail__sum').attributes('aria-expanded')).toBe('false')
    expect(w.emitted('update:folded')?.at(-1)).toEqual([true])
    w.unmount()
  })

  it('has no summary for a single step', () => {
    const w = mountRail([step('a')])
    expect(w.find('.iu-rail__sum').exists()).toBe(false)
    w.unmount()
  })

  it('renders both verb tenses and hides the inactive one', async () => {
    const w = mountRail([step('a', { status: 'running' })], { live: true })
    const [liveB, doneB] = w.findAll('.iu-rail__verb b')
    expect(liveB!.attributes('aria-hidden')).toBe('false')
    expect(doneB!.attributes('aria-hidden')).toBe('true')
    await w.setProps({ steps: [step('a')] })
    const [l2, d2] = w.findAll('.iu-rail__verb b')
    expect(l2!.attributes('aria-hidden')).toBe('true')
    expect(d2!.attributes('aria-hidden')).toBe('false')
    w.unmount()
  })

  it('opens the body of a failed step and gives step lines aria-expanded', async () => {
    const w = mountRail([step('a'), step('b', { status: 'failed', meta: 'failed' })])
    const lines = w.findAll('button.iu-rail__line')
    expect(lines[0]!.attributes('aria-expanded')).toBe('false')
    expect(lines[1]!.attributes('aria-expanded')).toBe('true')
    await lines[0]!.trigger('click')
    expect(w.findAll('button.iu-rail__line')[0]!.attributes('aria-expanded')).toBe('true')
    w.unmount()
  })

  it('shows elapsed time while running and the live note under the step', () => {
    const now = Date.parse('2026-11-12T12:00:10.000Z')
    const w = mountRail(
      [step('a', { status: 'running', startedAt: now - 7000, note: 'tail line', meta: 'x' })],
      { live: true, now },
    )
    expect(w.find('.iu-rail__meta').text()).toBe('7s')
    expect(w.find('.iu-rail__note').text()).toBe('tail line')
    w.unmount()
  })

  it('keeps a nested rail shut until its step is opened', async () => {
    const agent = step('ag', {
      kind: 'agent',
      status: 'running',
      children: [step('k')],
      hasBody: false,
    })
    const w = mountRail([agent], { live: true })
    const kids = () => w.find('.iu-rail__kids').element.closest('.iu-rail__fold')!
    expect(kids().getAttribute('data-shut')).toBe('true')
    await w.find('button.iu-rail__line').trigger('click')
    expect(kids().getAttribute('data-shut')).toBe('false')
    w.unmount()
  })

  it('does not take focus when steps are appended or the run folds', async () => {
    const w = mountRail([step('a'), step('b')])
    const outside = document.createElement('button')
    document.body.append(outside)
    outside.focus()
    await w.setProps({ steps: [step('a'), step('b'), step('c')] })
    await w.setProps({ folded: true })
    await nextTick()
    expect(document.activeElement).toBe(outside)
    outside.remove()
    w.unmount()
  })

  it('waits to fold until focus leaves the run', async () => {
    const w = mountRail([step('a'), step('b')])
    const line = w.find('button.iu-rail__line')
    ;(line.element as HTMLElement).focus()
    await w.setProps({ folded: true })
    expect(w.find('.iu-rail').attributes('data-folded')).toBe('false')
    await line.trigger('focusout', { relatedTarget: document.body })
    expect(w.find('.iu-rail').attributes('data-folded')).toBe('true')
    w.unmount()
  })

  it('carries the working line at its live end, with the subagents out', async () => {
    const w = mountRail([step('a'), step('b')], { live: true, working: true, agents: 2 })
    const tail = w.find('.iu-rail__tail')
    expect(tail.attributes('role')).toBe('status')
    expect(tail.text()).toBe('Working…')
    const flock = tail.findComponent(IuFlock)
    expect(flock.props('state')).toBe('working')
    expect(flock.props('agents')).toBe(2)
    expect(tail.findAll('.iu-flock__agent')).toHaveLength(2)
    await w.setProps({ agents: 1 })
    expect(tail.findComponent(IuFlock).props('agents')).toBe(1)
    await w.setProps({ working: false })
    expect(w.find('.iu-rail__tail').exists()).toBe(false)
    w.unmount()
  })

  it('lands the flock in the summary when a live run ends, then hands over to the step dots', async () => {
    vi.useFakeTimers()
    const w = mountRail([step('a'), step('b')], { live: true, working: true, flock: 'working' })
    await w.setProps({ live: false, working: false, flock: 'landed', folded: true })
    // the first frame is still the flight it was on the working line
    const perch = () => w.find('.iu-rail__sum .iu-rail__perch')
    expect(perch().findComponent(IuFlock).props('state')).toBe('working')
    await nextTick()
    await nextTick()
    expect(perch().classes()).toContain('iu-rail__perch--landed')
    expect(perch().findComponent(IuFlock).props('state')).toBe('landed')
    expect(w.find('.iu-rail').classes()).toContain('iu-rail--perched')
    expect(w.find('.iu-rail__tail').exists()).toBe(false)
    vi.advanceTimersByTime(800)
    await nextTick()
    expect(w.find('.iu-rail').classes()).not.toContain('iu-rail--perched')
    expect(w.findAll('.iu-rail__dot')).toHaveLength(2)
    vi.useRealTimers()
    w.unmount()
  })

  it('scatters when the run ends on a failed step and keeps the mark while the run is open', async () => {
    vi.useFakeTimers()
    const failed = [step('a'), step('b', { status: 'failed', meta: 'failed' })]
    const w = mountRail(failed, { live: true, working: true, flock: 'working' })
    await w.setProps({ live: false, working: false, flock: 'failed' })
    expect(w.find('.iu-rail__perch').findComponent(IuFlock).props('state')).toBe('working')
    await nextTick()
    await nextTick()
    expect(w.find('.iu-rail__perch').findComponent(IuFlock).props('state')).toBe('failed')
    vi.advanceTimersByTime(800)
    await nextTick()
    expect(w.find('.iu-rail__perch--failed').findComponent(IuFlock).props('state')).toBe('failed')
    // folded by the user, the summary is the step dots again
    await w.find('.iu-rail__sum').trigger('click')
    expect(w.find('.iu-rail').classes()).not.toContain('iu-rail--perched')
    vi.useRealTimers()
    w.unmount()
  })

  it('shows a run that was already over at rest: no flight, dots or the mark only', () => {
    const done = mountRail([step('a'), step('b')], { flock: 'landed', folded: true })
    expect(done.find('.iu-rail__perch').exists()).toBe(false)
    expect(done.findAll('.iu-rail__dot')).toHaveLength(2)
    done.unmount()
    const failed = mountRail([step('a'), step('b', { status: 'failed' })], { flock: 'failed' })
    const flock = failed.find('.iu-rail__perch').findComponent(IuFlock)
    expect(flock.props('state')).toBe('failed')
    // a flock that mounts at rest is settled from the first frame
    expect(flock.classes()).toContain('iu-flock--settled')
    failed.unmount()
  })
})
