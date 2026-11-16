// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@odin/shared/events'
import { connectEvents, type EventSourceLike } from './sse'
import { sharedEvents } from './http'

class FakeSource implements EventSourceLike {
  static all: FakeSource[] = []
  onopen: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  private handlers = new Map<string, ((ev: { data: string }) => void)[]>()
  constructor(readonly url: string) {
    FakeSource.all.push(this)
  }
  addEventListener(type: string, fn: (ev: { data: string }) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn])
  }
  close() {
    this.closed = true
  }
  open() {
    this.onopen?.({})
  }
  fail() {
    this.onerror?.({})
  }
  send(type: string, data: unknown) {
    for (const fn of this.handlers.get(type) ?? [])
      fn({ data: typeof data === 'string' ? data : JSON.stringify(data) })
  }
}

const opts = {
  createSource: (url: string) => new FakeSource(url),
  staleMs: 1000,
  backoffMs: 100,
  maxBackoffMs: 400,
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSource.all = []
})
afterEach(() => vi.useRealTimers())

describe('connectEvents', () => {
  it('delivers events, skips heartbeats and bad frames', () => {
    const got: ServerEvent[] = []
    connectEvents(e => got.push(e), undefined, opts)
    const es = FakeSource.all[0]!
    es.open()
    es.send('heartbeat', { type: 'heartbeat', at: 'now' })
    es.send('project.updated', 'not json')
    es.send('project.updated', { type: 'project.updated', project: 'odin' })
    expect(got).toEqual([{ type: 'project.updated', project: 'odin' }])
  })

  it('reconnects with backoff after an error and calls onReconnect only for the second open', () => {
    const onReconnect = vi.fn()
    connectEvents(() => {}, onReconnect, opts)
    FakeSource.all[0]!.open()
    expect(onReconnect).not.toHaveBeenCalled()

    FakeSource.all[0]!.fail()
    expect(FakeSource.all[0]!.closed).toBe(true)
    vi.advanceTimersByTime(99)
    expect(FakeSource.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSource.all).toHaveLength(2)
    FakeSource.all[1]!.open()
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('doubles the delay while attempts keep failing, up to the cap, and resets on open', () => {
    connectEvents(() => {}, undefined, opts)
    FakeSource.all[0]!.fail() // retry in 100
    vi.advanceTimersByTime(100)
    FakeSource.all[1]!.fail() // retry in 200
    vi.advanceTimersByTime(199)
    expect(FakeSource.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSource.all).toHaveLength(3)
    FakeSource.all[2]!.fail() // 400
    vi.advanceTimersByTime(400)
    FakeSource.all[3]!.fail() // capped at 400
    vi.advanceTimersByTime(400)
    expect(FakeSource.all).toHaveLength(5)
    FakeSource.all[4]!.open()
    FakeSource.all[4]!.fail() // reset: 100
    vi.advanceTimersByTime(100)
    expect(FakeSource.all).toHaveLength(6)
  })

  it('treats silence for staleMs as a lost connection; heartbeats keep it alive', () => {
    const onReconnect = vi.fn()
    connectEvents(() => {}, onReconnect, opts)
    const es = FakeSource.all[0]!
    es.open()
    vi.advanceTimersByTime(900)
    es.send('heartbeat', { type: 'heartbeat', at: 'x' })
    vi.advanceTimersByTime(900)
    expect(es.closed).toBe(false)
    vi.advanceTimersByTime(100)
    expect(es.closed).toBe(true)
    vi.advanceTimersByTime(100)
    FakeSource.all[1]!.open()
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('stops for good when unsubscribed', () => {
    const stop = connectEvents(() => {}, undefined, opts)
    FakeSource.all[0]!.fail()
    stop()
    vi.advanceTimersByTime(10_000)
    expect(FakeSource.all).toHaveLength(1)
  })
})

describe('sharedEvents', () => {
  it('opens one stream for all subscribers and closes it after the last leaves', () => {
    FakeSource.all = []
    const hub = sharedEvents('/api/events', opts)
    const a: string[] = []
    const b: string[] = []
    const offA = hub.subscribe(e => a.push(e.type))
    const offB = hub.subscribe(e => b.push(e.type))
    expect(FakeSource.all).toHaveLength(1)
    FakeSource.all[0]!.send('project.updated', { type: 'project.updated', project: 'odin' })
    expect([a, b]).toEqual([['project.updated'], ['project.updated']])
    offA()
    expect(FakeSource.all[0]!.closed).toBe(false)
    offB()
    expect(FakeSource.all[0]!.closed).toBe(true)
    hub.subscribe(() => {})
    expect(FakeSource.all).toHaveLength(2)
  })
})
