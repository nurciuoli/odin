// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockApi } from '@/api/mock'
import { createProjectsStore } from './projects'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function started() {
  const api = createMockApi()
  const store = createProjectsStore(api, 50)
  store.start()
  await vi.advanceTimersByTimeAsync(0)
  return { api, store }
}

describe('projects store', () => {
  it('reconciles removals and sync events received during a list request', async () => {
    const api = createMockApi()
    const snapshot = await api.listProjects()
    let resolve!: (list: typeof snapshot) => void
    api.listProjects = () =>
      new Promise(done => {
        resolve = done
      })
    const store = createProjectsStore(api)
    store.start()
    api.emit({ type: 'project.removed', project: 'rick' })
    api.emit({
      type: 'sync.status',
      project: 'odin',
      sync: { state: 'syncing', lastSyncAt: null, error: null },
    })
    resolve(snapshot)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.projects.value.map(p => p.name)).toEqual(['odin', 'harbor'])
    expect(store.projects.value[0]!.sync.state).toBe('syncing')
    store.stop()
  })
  it('loads the list on start', async () => {
    const { store } = await started()
    expect(store.loading.value).toBe(false)
    expect(store.projects.value.map(p => p.name)).toEqual(['odin', 'rick', 'harbor'])
  })

  it('refetches once and bumps the revision on project.updated', async () => {
    const { api, store } = await started()
    const spy = vi.spyOn(api, 'listProjects')
    expect(store.revision('rick')).toBe(0)
    api.emit({ type: 'project.updated', project: 'rick' })
    api.emit({ type: 'project.updated', project: 'rick' })
    expect(store.revision('rick')).toBe(2)
    await vi.advanceTimersByTimeAsync(60)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('patches sync status without refetching', async () => {
    const { api, store } = await started()
    const spy = vi.spyOn(api, 'listProjects')
    api.emit({
      type: 'sync.status',
      project: 'odin',
      sync: { state: 'syncing', lastSyncAt: null, error: null },
    })
    expect(store.projects.value[0]!.sync.state).toBe('syncing')
    await vi.advanceTimersByTimeAsync(100)
    expect(spy).not.toHaveBeenCalled()
  })

  it('drops a removed project', async () => {
    const { api, store } = await started()
    for (const session of await api.listSessions({ project: 'rick' }))
      await api.deleteSession(session.id)
    await api.removeProject('rick')
    expect(store.projects.value.map(p => p.name)).toEqual(['odin', 'harbor'])
  })

  it('refetches counts on session.removed', async () => {
    const { api, store } = await started()
    const spy = vi.spyOn(api, 'listProjects')
    api.emit({ type: 'session.removed', sessionId: 'gone' })
    await vi.advanceTimersByTimeAsync(60)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.error.value).toBeNull()
  })

  it('reports a failed load', async () => {
    const api = createMockApi()
    api.listProjects = () => Promise.reject(new Error('boom'))
    const store = createProjectsStore(api)
    store.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(store.error.value).toBe('boom')
    expect(store.loading.value).toBe(false)
  })

  it('stops listening on stop()', async () => {
    const { api, store } = await started()
    store.stop()
    api.emit({ type: 'project.updated', project: 'rick' })
    expect(store.revision('rick')).toBe(0)
  })
})
