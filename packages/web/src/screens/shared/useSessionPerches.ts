// Sidebar activity uses the same transcript-derived states and flock behavior as Home.
import { computed, onBeforeUnmount, ref, watch, type ComputedRef } from 'vue'
import type { Session } from '@odin/shared/api'
import { applyHarnessEvent } from '@odin/shared/transcript'
import { useApi } from '@/api'
import { useSessions } from '@/app/sessions'
import { buildPerch, type LaneSource } from './lanes'
import { useServerEvents } from './useResource'

export function useSessionPerches(list: ComputedRef<Session[]>) {
  const api = useApi()
  const live = useSessions()
  const sources = ref<Record<string, LaneSource>>({})
  const now = ref(Date.now())
  const pending = new Map<string, object>()
  const timer = setInterval(() => (now.value = Date.now()), 30_000)
  let disposed = false

  async function load(s: Session) {
    const request = {}
    pending.set(s.id, request)
    try {
      const detail = await api.getSession(s.id)
      if (disposed || pending.get(s.id) !== request) return
      sources.value = { ...sources.value, [s.id]: { detail } }
    } catch {
      // A missing detail still leaves the session record and state available.
    } finally {
      if (pending.get(s.id) === request) pending.delete(s.id)
    }
  }
  watch(
    () => list.value.map(s => `${s.id}:${s.state}`).join(','),
    () => {
      const ids = new Set(list.value.map(s => s.id))
      for (const id of Object.keys(sources.value)) if (!ids.has(id)) delete sources.value[id]
      for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id)
      for (const s of list.value)
        if (!sources.value[s.id] || sources.value[s.id].detail.state !== s.state) void load(s)
    },
    { immediate: true },
  )
  useServerEvents(
    e => {
      if (e.type !== 'session.event') return
      const src = sources.value[e.sessionId]
      if (!src) return
      const event = e.event
      let detail = src.detail
      let times = src.extraTimes ?? []
      if (
        event.type === 'entry' ||
        event.type === 'delta' ||
        event.type === 'tool.result' ||
        event.type === 'task'
      ) {
        detail = { ...detail, transcript: applyHarnessEvent(detail.transcript, event) }
        const at = Date.now()
        // Only the latest live timestamp is needed to determine quiet activity.
        times = [at]
        now.value = at
      } else if (event.type === 'permission.request') {
        if (!detail.pending.some(p => p.id === event.request.id))
          detail = { ...detail, pending: [...detail.pending, event.request] }
      } else if (event.type === 'permission.resolved') {
        detail = { ...detail, pending: detail.pending.filter(p => p.id !== event.requestId) }
      } else return
      sources.value = { ...sources.value, [e.sessionId]: { detail, extraTimes: times } }
    },
    () => {
      for (const s of list.value) void load(s)
    },
  )
  onBeforeUnmount(() => {
    disposed = true
    pending.clear()
    clearInterval(timer)
  })
  return computed(() =>
    Object.fromEntries(
      list.value.map(s => [
        s.id,
        buildPerch(
          {
            ...sources.value[s.id],
            detail: {
              ...(sources.value[s.id]?.detail ?? { pending: [], transcript: [] }),
              ...s,
            },
            work: live.workOf(s.id),
          },
          now.value,
        ),
      ]),
    ),
  )
}
