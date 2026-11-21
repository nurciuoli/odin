import { expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { SessionDetail } from '@odin/shared/api'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { useSessionView } from './useSessionView'

async function pendingView(id = FIXTURE_SESSION_IDS.idle) {
  const api = createMockApi()
  const snapshot = await api.getSession(id)
  let resolve!: (detail: SessionDetail) => void
  api.getSession = () =>
    new Promise(done => {
      resolve = done
    })
  let state!: ReturnType<typeof useSessionView>
  const wrapper = mount(
    defineComponent({
      setup() {
        state = useSessionView(ref(id))
        return () => null
      },
    }),
    {
      global: { provide: { [API_KEY as symbol]: api } },
    },
  )
  return { api, id, snapshot, resolve, state, wrapper }
}

it('replays record and artifact events received during the initial fetch', async () => {
  const { api, id, snapshot, resolve, state, wrapper } = await pendingView()
  api.emit({ type: 'session.updated', session: { ...snapshot, title: 'New title' } })
  const artifact = { ...api.db.artifacts[0]!, sessionId: id }
  api.emit({ type: 'artifact.updated', sessionId: id, artifact })
  resolve(snapshot)
  await flushPromises()
  expect(state.view.value?.detail.title).toBe('New title')
  expect(state.view.value?.detail.artifacts.map(a => a.id)).toContain(artifact.id)
  wrapper.unmount()
})

it('does not resurrect a session removed while its detail fetch is pending', async () => {
  const { api, id, snapshot, resolve, state, wrapper } = await pendingView()
  api.emit({ type: 'session.removed', sessionId: id })
  resolve(snapshot)
  await flushPromises()
  expect(state.phase.value).toBe('removed')
  wrapper.unmount()
})

it('deduplicates buffered deltas already reflected in a partial snapshot', async () => {
  const { api, id, snapshot, resolve, state, wrapper } = await pendingView()
  snapshot.streaming = ['partial']
  snapshot.transcript.push({
    kind: 'assistant',
    id: 'partial',
    text: 'hello',
    model: null,
    at: null,
    parentToolUseId: null,
  })
  api.emit({
    type: 'session.event',
    sessionId: id,
    event: {
      type: 'delta',
      entryId: 'partial',
      kind: 'assistant',
      text: 'hello',
      offset: 0,
      parentToolUseId: null,
    },
  })
  api.emit({
    type: 'session.event',
    sessionId: id,
    event: {
      type: 'delta',
      entryId: 'partial',
      kind: 'assistant',
      text: ' world',
      offset: 5,
      parentToolUseId: null,
    },
  })
  resolve(snapshot)
  await flushPromises()
  expect(state.view.value?.detail.transcript.find(e => e.id === 'partial')).toMatchObject({
    text: 'hello world',
  })
  wrapper.unmount()
})

it('replays held updates into the retained view when a reconnect fetch fails', async () => {
  const { api, snapshot, resolve, state, wrapper } = await pendingView()
  resolve(snapshot)
  await flushPromises()
  let reject!: (error: Error) => void
  api.getSession = () =>
    new Promise((_done, fail) => {
      reject = fail
    })
  const loading = state.load()
  api.emit({ type: 'session.updated', session: { ...snapshot, title: 'Updated during failure' } })
  reject(new Error('offline'))
  await loading
  expect(state.phase.value).toBe('ready')
  expect(state.view.value?.detail.title).toBe('Updated during failure')
  wrapper.unmount()
})

it('reads new terminal activity only when the open view has loaded the transcript', async () => {
  const { api, snapshot, resolve, state, wrapper } = await pendingView(FIXTURE_SESSION_IDS.external)
  snapshot.activityAt = null
  resolve(snapshot)
  await flushPromises()
  const activityAt = '2026-11-21T16:00:00.000Z'
  const record = { ...snapshot, activityAt }
  let deliver!: (detail: SessionDetail) => void
  const getSession = vi.fn(
    () =>
      new Promise<SessionDetail>(done => {
        deliver = done
      }),
  )
  api.getSession = getSession

  // The event arrives during a request that began before the native turn.
  const loading = state.load()
  api.emit({ type: 'session.updated', session: record })
  deliver(snapshot)
  await loading
  expect(getSession).toHaveBeenCalledTimes(2)
  expect(state.view.value?.detail.activityAt).toBeNull()

  deliver({
    ...record,
    transcript: [
      ...snapshot.transcript,
      {
        kind: 'assistant',
        id: 'new-terminal-reply',
        text: 'Reply from the terminal',
        model: null,
        at: activityAt,
        parentToolUseId: null,
      },
    ],
  })
  await flushPromises()
  expect(state.view.value?.detail.activityAt).toBe(activityAt)
  expect(state.view.value?.detail.transcript.at(-1)?.id).toBe('new-terminal-reply')
  wrapper.unmount()
})

it.each(['stale', 'failed'])(
  'does not retry repeated offline activity after a %s transcript fetch',
  async outcome => {
    const { api, snapshot, resolve, state, wrapper } = await pendingView(
      FIXTURE_SESSION_IDS.external,
    )
    snapshot.activityAt = null
    resolve(snapshot)
    await flushPromises()
    const getSession = vi.fn(() =>
      outcome === 'stale' ? Promise.resolve(snapshot) : Promise.reject(new Error('offline')),
    )
    api.getSession = getSession
    const record = { ...snapshot, activityAt: '2026-11-21T16:00:00.000Z' }
    api.emit({ type: 'session.updated', session: record })
    api.emit({ type: 'session.updated', session: record })
    await flushPromises()

    expect(getSession).toHaveBeenCalledTimes(1)
    expect(state.phase.value).toBe('ready')
    expect(state.view.value?.detail.activityAt).toBeNull()
    wrapper.unmount()
  },
)
