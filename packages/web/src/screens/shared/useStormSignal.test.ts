import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, defineComponent, h, nextTick, ref } from 'vue'
import type { Session } from '@odin/shared/api'
import { SESSIONS_KEY, type SessionsStore } from '@/app/sessions'
import { markSeen, resetSeen } from '@/app/seen'
import { STORM } from './storm'
import { useStormSignal } from './useStormSignal'

const session = (id: string, state: Session['state']): Session =>
  ({
    id,
    project: 'odin',
    state,
    archived: false,
    aside: false,
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }) as unknown as Session

function setup() {
  const list = ref<Session[]>([])
  const loading = ref(false)
  const store = {
    active: computed(() => list.value.filter(s => s.state === 'running' || s.state === 'waiting')),
    sidebar: computed(() => list.value),
    loading,
  } as unknown as SessionsStore
  let out!: ReturnType<typeof useStormSignal>
  const el = document.createElement('div')
  const app = createApp(
    defineComponent({
      setup() {
        out = useStormSignal()
        return () => h('div')
      },
    }),
  )
  app.provide(SESSIONS_KEY, store)
  app.mount(el)
  return { list, out, app }
}

describe('useStormSignal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSeen()
  })
  afterEach(() => vi.useRealTimers())

  it('brings the weather in with the first session, flashes when it ends, and clears a lag after it is read', async () => {
    const { list, out } = setup()
    expect(out.active.value).toBe(false)

    list.value = [session('a', 'running')]
    await nextTick()
    expect(out.active.value).toBe(true)

    // it finishes: a flash, and the sky stays while it is unread
    list.value = [session('a', 'idle')]
    await nextTick()
    expect(out.signal.value?.kind).toBe('done')
    vi.advanceTimersByTime(STORM.lag * 1000 * 3)
    expect(out.active.value).toBe(true)

    // read: still stormy for the lag, then clear
    markSeen(list.value[0]!)
    await nextTick()
    vi.advanceTimersByTime(STORM.lag * 1000 - 1000)
    expect(out.active.value).toBe(true)
    vi.advanceTimersByTime(2000)
    expect(out.active.value).toBe(false)
  })

  it('keeps the weather when a new session starts during the lag', async () => {
    const { list, out } = setup()
    list.value = [session('a', 'running')]
    await nextTick()
    list.value = [session('a', 'idle')]
    await nextTick()
    markSeen(list.value[0]!)
    await nextTick()
    vi.advanceTimersByTime(30_000)
    list.value = [...list.value, session('b', 'running')]
    await nextTick()
    vi.advanceTimersByTime(STORM.lag * 1000 * 2)
    expect(out.active.value).toBe(true)
  })

  it('does not summon a storm for an old unread session this page never saw run', async () => {
    const { list, out } = setup()
    list.value = [session('old', 'idle')]
    await nextTick()
    expect(out.active.value).toBe(false)
  })
})
