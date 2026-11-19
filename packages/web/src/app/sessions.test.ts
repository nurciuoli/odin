// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { Session } from '@odin/shared/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createSessionsStore, SIDEBAR_LIMIT, sidebarOrder, titleFor } from './sessions'

async function started() {
  const api = createMockApi()
  const store = createSessionsStore(api)
  store.start()
  await flushPromises()
  return { api, store }
}

// the store holds reactive proxies, which structuredClone (the mock's emit) refuses
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v))

const sessionOf = async (api: ReturnType<typeof createMockApi>, state: Session['state']) =>
  (await api.listSessions({ state: [state] }))[0]!

describe('sessions store', () => {
  it('keeps task events newer than an idle transcript snapshot', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.idle
    const detail = await api.getSession(id)
    const source = api.db.transcripts[FIXTURE_SESSION_IDS.running]!.find(e => e.kind === 'task')!
    if (source.kind !== 'task') throw new Error('Missing task')
    detail.transcript = [{ ...source, task: { ...source.task, state: 'running' } }]
    const get = api.getSession
    let resolve!: (value: typeof detail) => void
    api.getSession = sessionId =>
      sessionId === id
        ? new Promise(done => {
            resolve = done
          })
        : get(sessionId)
    const store = createSessionsStore(api)
    store.start()
    await flushPromises()
    api.emit({
      type: 'session.event',
      sessionId: id,
      event: { type: 'task', task: { ...source.task, state: 'completed' } },
    })
    resolve(detail)
    await flushPromises()
    expect(store.workOf(id)).toBeUndefined()
    store.stop()
  })
  it('keeps newer events when an older active list resolves', async () => {
    const api = createMockApi()
    const idle = await sessionOf(api, 'idle')
    const snapshot = await api.listSessions({ state: ['running', 'waiting'] })
    const list = api.listSessions
    let resolve!: (sessions: Session[]) => void
    api.listSessions = filter =>
      filter?.state
        ? new Promise<Session[]>(done => {
            resolve = done
          })
        : list(filter)
    const store = createSessionsStore(api)
    store.start()
    api.emit({ type: 'session.updated', session: { ...idle, state: 'running' } })
    api.emit({ type: 'session.removed', sessionId: snapshot[0]!.id })
    resolve(snapshot)
    await flushPromises()
    expect(store.active.value.some(s => s.id === idle.id)).toBe(true)
    expect(store.active.value.some(s => s.id === snapshot[0]!.id)).toBe(false)
    store.stop()
  })
  it('loads the running and waiting sessions, waiting first', async () => {
    const { store } = await started()
    expect(store.loading.value).toBe(false)
    expect(store.active.value.length).toBeGreaterThan(0)
    expect(store.active.value.every(s => s.state === 'running' || s.state === 'waiting')).toBe(true)
    expect(store.active.value[0]!.state).toBe('waiting')
    expect(store.countsFor('odin').waiting).toBe(store.waiting.value.length)
  })

  it('follows session.updated: a session leaving running drops out, a new one joins', async () => {
    const { api, store } = await started()
    const running = store.running.value[0]!
    const before = store.revision.value
    api.emit({ type: 'session.updated', session: plain({ ...running, state: 'idle' }) })
    expect(store.running.value.find(s => s.id === running.id)).toBeUndefined()
    const idle = await sessionOf(api, 'idle')
    api.emit({ type: 'session.updated', session: { ...idle, state: 'waiting' } })
    expect(store.waiting.value.map(s => s.id)).toContain(idle.id)
    expect(store.revision.value).toBe(before + 2)
  })

  it('ignores archived sessions and drops removed ones', async () => {
    const { api, store } = await started()
    const waiting = store.waiting.value[0]!
    api.emit({ type: 'session.updated', session: plain({ ...waiting, archived: true }) })
    expect(store.active.value.find(s => s.id === waiting.id)).toBeUndefined()
    const running = store.running.value[0]!
    api.emit({ type: 'session.removed', sessionId: running.id })
    expect(store.active.value.find(s => s.id === running.id)).toBeUndefined()
  })

  it('leaves side threads out, even when one starts running', async () => {
    const { api, store } = await started()
    const side = (await api.listSessions({ aside: true }))[0]!
    api.emit({ type: 'session.updated', session: { ...side, state: 'running' } })
    expect(store.active.value.some(s => s.id === side.id)).toBe(false)
    expect(store.sidebar.value.some(s => s.aside)).toBe(false)
    store.stop()
  })

  it('builds the sidebar list: waiting, running, then the rest, at most eight', async () => {
    const { store } = await started()
    expect(store.recentPhase.value).toBe('ready')
    const list = store.sidebar.value
    expect(list.length).toBeLessThanOrEqual(SIDEBAR_LIMIT)
    expect(list.slice(0, 2).map(s => s.state)).toEqual(['waiting', 'running'])
    store.stop()
  })

  it('reports a failed load and stops listening', async () => {
    const api = createMockApi()
    api.listSessions = () => Promise.reject(new Error('boom'))
    const store = createSessionsStore(api)
    store.start()
    await flushPromises()
    expect(store.error.value).toBe('boom')
    store.stop()
    const before = store.revision.value
    api.emit({ type: 'session.removed', sessionId: 'x' })
    expect(store.revision.value).toBe(before)
  })

  it('orders by start time while running or waiting, so updates never reorder those rows', () => {
    const at = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString()
    const row = (
      id: string,
      state: Session['state'],
      created: number,
      updated: number,
      pinned = false,
    ) => ({ id, state, createdAt: at(created), updatedAt: at(updated), pinned }) as Session
    const order = sidebarOrder([
      row('idle-old', 'idle', 0, 1),
      row('run-a', 'running', 10, 50),
      row('run-b', 'running', 20, 30),
      row('wait', 'waiting', 5, 6),
      row('idle-pinned', 'idle', 0, 0, true),
      row('ended-new', 'ended', 0, 40),
    ]).map(s => s.id)
    expect(order).toEqual(['wait', 'run-b', 'run-a', 'idle-pinned', 'ended-new', 'idle-old'])
  })

  it('puts the waiting count in the title', () => {
    expect(titleFor(0)).toBe('Odin')
    expect(titleFor(2)).toBe('(2) Odin')
  })

  it('counts an idle session with running background work as active', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.idle
    const source = api.db.transcripts[FIXTURE_SESSION_IDS.running]!.find(
      e => e.kind === 'task' && e.task.kind === 'agent',
    )!
    if (source.kind !== 'task') throw new Error('Missing agent fixture')
    api.db.transcripts[id]!.push({
      ...structuredClone(source),
      task: { ...source.task, state: 'running' },
    })
    const store = createSessionsStore(api)
    store.start()
    await flushPromises()
    const row = store.active.value.find(s => s.id === id)
    expect(row?.state).toBe('running')
    expect(store.running.value.map(s => s.id)).toContain(id)
    expect(store.workOf(id)).toEqual({ agents: 1, commands: 0 })
    expect(store.sidebar.value.find(s => s.id === id)?.state).toBe('running')
    // the agent finishes: a task event takes the session back out
    api.emit({
      type: 'session.event',
      sessionId: id,
      event: { type: 'task', task: plain({ ...source.task, state: 'completed' }) },
    })
    expect(store.active.value.some(s => s.id === id)).toBe(false)
    store.stop()
  })
})
