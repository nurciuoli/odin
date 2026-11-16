import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuFlock, type FlockState } from '.'

afterEach(() => vi.useRealTimers())

describe('IuFlock', () => {
  it('renders as it always has by default: five decorative dots, no state classes', () => {
    const w = mount(IuFlock)
    expect(w.classes()).toEqual(['iu-flock', 'iu-flock--md'])
    expect(w.findAll('i')).toHaveLength(5)
    expect(w.findAll('.iu-flock__agent')).toHaveLength(0)
    expect(w.attributes('aria-hidden')).toBe('true')
    expect(w.attributes('role')).toBeUndefined()
  })

  it('keeps the small size class and gives the large flock more dots', () => {
    expect(mount(IuFlock, { props: { size: 'sm' } }).classes()).toEqual([
      'iu-flock',
      'iu-flock--sm',
    ])
    const lg = mount(IuFlock, { props: { size: 'lg' } })
    expect(lg.classes()).toContain('iu-flock--lg')
    expect(lg.findAll('i')).toHaveLength(9)
    const xl = mount(IuFlock, { props: { size: 'xl', state: 'idle' } })
    expect(xl.classes()).toEqual(
      expect.arrayContaining(['iu-flock--xl', 'iu-flock--lg', 'iu-flock--idle']),
    )
    expect(xl.findAll('i')).toHaveLength(9)
  })

  it('carries a class per state and per tone', () => {
    for (const state of ['quiet', 'waiting', 'landed', 'failed', 'idle'] satisfies FlockState[]) {
      expect(mount(IuFlock, { props: { state } }).classes()).toContain(`iu-flock--${state}`)
    }
    expect(mount(IuFlock, { props: { state: 'working' } }).classes()).not.toContain(
      'iu-flock--working',
    )
    expect(mount(IuFlock, { props: { tone: 'neutral' } }).classes()).toContain('iu-flock--neutral')
  })

  it('is settled at once when it mounts at rest, and never while flying', () => {
    for (const state of ['waiting', 'landed', 'failed', 'idle'] satisfies FlockState[]) {
      expect(mount(IuFlock, { props: { state } }).classes()).toContain('iu-flock--settled')
    }
    expect(mount(IuFlock, { props: { state: 'quiet' } }).classes()).not.toContain(
      'iu-flock--settled',
    )
  })

  it('settles a moment after coming down, and unsettles to take off', async () => {
    vi.useFakeTimers()
    const w = mount(IuFlock)
    await w.setProps({ state: 'landed' })
    expect(w.classes()).toContain('iu-flock--landed')
    expect(w.classes()).not.toContain('iu-flock--settled')
    await vi.advanceTimersByTimeAsync(1000)
    expect(w.classes()).toContain('iu-flock--settled')
    await w.setProps({ state: 'working' })
    expect(w.classes()).toEqual(['iu-flock', 'iu-flock--md'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(w.classes()).not.toContain('iu-flock--settled')
  })

  it('shows one dot per subagent, three at most, and only while flying', () => {
    const agents = (props: InstanceType<typeof IuFlock>['$props']) =>
      mount(IuFlock, { props }).findAll('.iu-flock__agent').length
    expect(agents({ agents: 1 })).toBe(1)
    expect(agents({ agents: 2, state: 'quiet' })).toBe(2)
    expect(agents({ agents: 7 })).toBe(3)
    expect(agents({ agents: -2 })).toBe(0)
    expect(agents({ agents: 2, state: 'waiting' })).toBe(0)
    expect(agents({ agents: 2, state: 'landed' })).toBe(0)
  })

  it('is a status region when labelled', () => {
    const w = mount(IuFlock, { props: { label: 'Working', state: 'quiet' } })
    expect(w.attributes('role')).toBe('status')
    expect(w.attributes('aria-label')).toBe('Working')
    expect(w.attributes('aria-hidden')).toBeUndefined()
  })
})
