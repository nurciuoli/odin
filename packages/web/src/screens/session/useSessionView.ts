// Loads a session and keeps it live: `getSession`, then `session.event` frames folded with applySessionEvent and
// `session.updated` records merged in. Frames that arrive while a fetch is in flight are held and applied on top of
// its result; a reconnect refetches.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { MessageQueue, Session, SessionDetail } from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import { ApiRequestError, useApi } from '@/api'
import { activityAt } from '@/app/seen'
import {
  applyActionRecord,
  applySessionEvent,
  applySessionRecord,
  createSessionView,
  type SessionView,
} from './sessionView'

export type Phase = 'loading' | 'ready' | 'error' | 'removed'

/** Offline terminal activity has no transcript frames for the open view to fold in. */
function offlineActivity(current: SessionDetail, incoming: Session): number | undefined {
  if (
    current.live ||
    incoming.origin !== 'external' ||
    incoming.state === 'running' ||
    incoming.state === 'waiting' ||
    !incoming.activityAt
  )
    return
  const previous = Date.parse(activityAt(current) ?? '')
  const next = Date.parse(incoming.activityAt)
  if (next > (Number.isNaN(previous) ? -Infinity : previous)) return next
}

export function useSessionView(id: Ref<string>) {
  const api = useApi()
  const view = shallowRef<SessionView | null>(null)
  const phase = ref<Phase>('loading')
  const error = ref<{ status: number; message: string } | null>(null)

  let latest = 0
  // non-null while a fetch is in flight: frames wait here
  let held: ServerEvent[] | null = null
  let heldQueue: MessageQueue | null = null

  function setQueue(queue: MessageQueue) {
    if (held && (!heldQueue || queue.revision >= heldQueue.revision)) heldQueue = queue
    const current = view.value
    if (current && queue.revision >= current.detail.messageQueue.revision)
      view.value = { ...current, detail: { ...current.detail, messageQueue: queue } }
  }

  async function load(requestedActivity = -Infinity) {
    const token = ++latest
    held = []
    heldQueue = null
    let latestExternalActivity = requestedActivity
    function replay(event: ServerEvent) {
      onEvent(event, activity => {
        latestExternalActivity = Math.max(latestExternalActivity, activity)
      })
    }

    try {
      const detail = await api.getSession(id.value)
      if (token !== latest) return
      const prev = view.value?.detail.id === detail.id ? view.value : null
      let next = createSessionView(detail)
      // what only live events carry survives a refetch
      if (prev) {
        next = { ...next, noticeSeq: prev.noticeSeq }
        if (prev.detail.messageQueue.revision > next.detail.messageQueue.revision)
          next = { ...next, detail: { ...next.detail, messageQueue: prev.detail.messageQueue } }
      }
      const queued = heldQueue as MessageQueue | null
      if (queued && queued.revision >= next.detail.messageQueue.revision)
        next = { ...next, detail: { ...next.detail, messageQueue: queued } }
      view.value = next
      const frames = held
      held = null
      for (const event of frames) replay(event)
      phase.value = 'ready'
      error.value = null
    } catch (e) {
      if (token !== latest) return
      if (phase.value === 'ready') {
        const frames = held ?? []
        held = null
        for (const event of frames) replay(event)
        if (heldQueue) setQueue(heldQueue)
      }
      if (phase.value !== 'ready') {
        error.value = {
          status: e instanceof ApiRequestError ? e.status : 0,
          message: e instanceof Error ? e.message : String(e),
        }
        phase.value = 'error'
      }
    } finally {
      if (token === latest) {
        held = null
        // A notification received during this fetch can warrant another snapshot. An older or repeated
        // notification can't keep retrying if the fetch fails or the native history is behind.
        if (latestExternalActivity > requestedActivity) void load(latestExternalActivity)
      }
    }
  }

  function onEvent(event: ServerEvent, replayActivity?: (activity: number) => void) {
    if (event.type === 'session.removed' && event.sessionId === id.value) {
      latest++
      held = null
      phase.value = 'removed'
      return
    }
    const belongs =
      event.type === 'session.updated'
        ? event.session.id === id.value
        : 'sessionId' in event && event.sessionId === id.value
    if (held && belongs && event.type !== 'session.queue') {
      held.push(event)
      return
    }
    switch (event.type) {
      case 'session.event':
        if (event.sessionId !== id.value) return
        if (view.value) view.value = applySessionEvent(view.value, event.event)
        // Grok has no live user entry. OpenCode compaction replaces stored history. Reload after the
        // turn so the next detail read is the native transcript, without inventing entry ids.
        if (
          !replayActivity &&
          event.event.type === 'turn.end' &&
          (view.value?.detail.harness === 'grok' || view.value?.detail.harness === 'opencode')
        )
          void load()
        return
      case 'session.updated': {
        const current = view.value
        if (!current || event.session.id !== id.value) return
        const activity = offlineActivity(current.detail, event.session)
        if (activity !== undefined) {
          if (replayActivity) replayActivity(activity)
          else void load(activity)
          return
        }
        if (event.session.updatedAt >= current.detail.updatedAt)
          view.value = applySessionRecord(current, event.session)
        return
      }
      case 'session.queue':
        if (event.sessionId !== id.value) return
        setQueue(event.queue)
        return
      case 'session.removed':
        if (event.sessionId === id.value) phase.value = 'removed'
        return
      case 'artifact.updated': {
        const v = view.value
        if (!v || event.sessionId !== id.value) return
        const existing = v.detail.artifacts.find(a => a.id === event.artifact.id)
        if (existing && existing.latestVersion > event.artifact.latestVersion) return
        const others = v.detail.artifacts.filter(a => a.id !== event.artifact.id)
        view.value = { ...v, detail: { ...v.detail, artifacts: [...others, event.artifact] } }
        return
      }
    }
  }

  /** A record an action returned (rename, pin, end…). */
  function setRecord(session: Session) {
    const current = view.value
    if (current?.detail.id !== session.id) return
    if (offlineActivity(current.detail, session) !== undefined) {
      onEvent({ type: 'session.updated', session })
      return
    }
    view.value = applyActionRecord(current, session)
  }

  let off: (() => void) | null = null
  onMounted(() => {
    off = api.subscribe(onEvent, () => void load())
    void load()
  })
  onBeforeUnmount(() => {
    off?.()
    off = null
    latest++
  })
  watch(id, () => {
    view.value = null
    phase.value = 'loading'
    error.value = null
    void load()
  })

  return { view, phase, error, load: () => load(), setRecord, setQueue }
}
