// The sessions that are running or waiting for you, kept live from `session.updated`. One subscription for the whole
// app (like the project store): the sidebar counts, Home's lists and the document title read it.
import { computed, inject, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue'
import type { Session } from '@odin/shared/api'
import { mostRecentRunFirst } from '@odin/shared/session'
import type { TaskActivity } from '@odin/shared/harness'
import { taskKey } from '@odin/shared/harness'
import type { ServerEvent } from '@odin/shared/events'
import type { Api } from '@/api/types'
import { countWork, workTotal, type WorkCount } from './backgroundWork'
import { activityAt, isUnread } from './seen'

export interface SessionsStore {
  /**
   * Running and waiting sessions in sidebar order, plus idle ones whose turn ended but still have subagents or
   * background commands running (returned as `running` copies; see `workOf`). Waiting first, then running, each
   * newest start first. */
  active: ComputedRef<Session[]>
  waiting: ComputedRef<Session[]>
  running: ComputedRef<Session[]>
  /** true until the first list (or failure) arrives */
  loading: Ref<boolean>
  error: Ref<string | null>
  /** Bumps on every session.updated / session.removed / reconnect: watch it to refetch a list of your own. */
  revision: Ref<number>
  reload(): Promise<void>
  /** Waiting + running for one project (the sidebar). */
  countsFor(project: string): { waiting: number; running: number }
  /**
   * The sidebar's sessions list: the active ones plus the most recent others, in `sidebarOrder`, at most
   * `SIDEBAR_LIMIT`. ⌥↑/⌥↓ and ⌘1…9 step through the same list.
   */
  sidebar: ComputedRef<Session[]>
  /** The recent list behind `sidebar`: 'loading' until it first arrives. */
  recentPhase: Ref<'loading' | 'ready' | 'error'>
  reloadRecent(): Promise<void>
  /** Running subagents and commands of a session that is idle on the server (empty for any other session). */
  workOf(id: string): WorkCount | undefined
  start(): void
  stop(): void
}

export const SESSIONS_KEY: InjectionKey<SessionsStore> = Symbol('odin-sessions')

export function useSessions(): SessionsStore {
  const store = inject(SESSIONS_KEY, null)
  if (!store) throw new Error('useSessions() needs the app shell to provide the sessions store')
  return store
}

// Side threads live beside their parent session, never in the app-wide lists.
const isActive = (s: Session) =>
  !s.archived && !s.aside && (s.state === 'running' || s.state === 'waiting')

export const SIDEBAR_LIMIT = 8

const rank = (s: Session) =>
  s.state === 'waiting' ? 0 : s.state === 'running' ? 1 : isUnread(s) ? 2 : 3
/**
 * Waiting, then running, then unopened finished sessions, then read sessions. Waiting and running sessions keep
 * their start order (newest start first), so rows don't jump on every update; each finished group goes pinned
 * first, then most recently active. This also keeps keyboard navigation in visible section order.
 */
export function sidebarOrder(list: readonly Session[]): Session[] {
  return [...list].sort((a, b) => {
    const group = rank(a)
    const difference = group - rank(b)
    if (difference) return difference
    if (group < 2) return b.createdAt.localeCompare(a.createdAt)
    const pinned = Number(b.pinned) - Number(a.pinned)
    if (pinned) return pinned
    return mostRecentRunFirst(a, b)
  })
}

/** `(2) Odin` while two sessions wait for you. */
export function titleFor(waiting: number): string {
  return waiting > 0 ? `(${waiting}) Odin` : 'Odin'
}

export function createSessionsStore(api: Api): SessionsStore {
  const byId = ref<Record<string, Session>>({})
  const loading = ref(true)
  const error = ref<string | null>(null)
  const revision = ref(0)
  const recent = ref<Session[]>([])
  const recentPhase = ref<'loading' | 'ready' | 'error'>('loading')
  // ── background work of idle sessions ──
  // The list API has no such count, so recent idle sessions' transcripts are read once per change and kept current
  // from `task` events.
  const tasksById = ref<Record<string, Record<string, Pick<TaskActivity, 'kind' | 'state'>>>>({})
  const loadedAt = new Map<string, string>()
  const pendingWork = new Map<string, Record<string, Pick<TaskActivity, 'kind' | 'state'>>>()
  const WORK_WINDOW = 24 * 60 * 60 * 1000
  async function loadWork(s: Session, at: string) {
    if (loadedAt.get(s.id) === at) return
    loadedAt.set(s.id, at)
    const changes: Record<string, Pick<TaskActivity, 'kind' | 'state'>> = {}
    pendingWork.set(s.id, changes)
    try {
      const detail = await api.getSession(s.id)
      if (pendingWork.get(s.id) !== changes) return
      const tasks: Record<string, Pick<TaskActivity, 'kind' | 'state'>> = {}
      for (const e of detail.transcript) if (e.kind === 'task') tasks[taskKey(e.task)] = e.task
      tasksById.value = { ...tasksById.value, [s.id]: { ...tasks, ...changes } }
    } catch {
      if (pendingWork.get(s.id) === changes) loadedAt.delete(s.id)
    } finally {
      if (pendingWork.get(s.id) === changes) pendingWork.delete(s.id)
    }
  }
  function trackWork(list: Session[]) {
    for (const s of list) {
      const at = activityAt(s)
      if (s.state === 'idle' && !s.aside && at && Date.now() - Date.parse(at) < WORK_WINDOW)
        void loadWork(s, at)
    }
  }
  const workById = computed(() => {
    const out: Record<string, WorkCount> = {}
    for (const s of recent.value) {
      const work = countWork(Object.values(tasksById.value[s.id] ?? {}))
      if (s.state === 'idle' && !s.archived && workTotal(work)) out[s.id] = work
    }
    return out
  })
  let unsubscribe: (() => void) | null = null
  let recentTimer: ReturnType<typeof setTimeout> | undefined

  let recentRequest = 0
  let activeRequest = 0
  let activePending = false
  let recentPending = false
  const activeChanges = new Map<string, Session | null>()
  const recentChanges = new Map<string, Session | null>()
  async function reloadRecent() {
    const request = ++recentRequest
    recentPending = true
    recentChanges.clear()
    try {
      const list = await api.listSessions({ archived: false, limit: SIDEBAR_LIMIT })
      if (request !== recentRequest) return
      const next = new Map(list.filter(s => !s.aside).map(s => [s.id, s]))
      for (const [id, session] of recentChanges) {
        if (session && !session.archived && !session.aside) next.set(id, session)
        else next.delete(id)
      }
      recent.value = [...next.values()].sort(mostRecentRunFirst).slice(0, SIDEBAR_LIMIT)
      trackWork(recent.value)
      recentPhase.value = 'ready'
    } catch {
      if (request === recentRequest && recentPhase.value !== 'ready') recentPhase.value = 'error'
    } finally {
      if (request === recentRequest) {
        recentPending = false
        recentChanges.clear()
      }
    }
  }
  // Events come in bursts (a turn emits several updates): refetch the recent list once they settle.
  function refreshRecent() {
    clearTimeout(recentTimer)
    recentTimer = setTimeout(() => void reloadRecent(), 250)
  }

  async function reload() {
    const request = ++activeRequest
    activePending = true
    activeChanges.clear()
    try {
      const list = await api.listSessions({ state: ['running', 'waiting'] })
      if (request !== activeRequest) return
      const next = Object.fromEntries(list.filter(isActive).map(s => [s.id, s]))
      for (const [id, session] of activeChanges) {
        if (session && isActive(session)) next[id] = session
        else delete next[id]
      }
      byId.value = next
      error.value = null
    } catch (e) {
      if (request !== activeRequest) return
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (request === activeRequest) {
        loading.value = false
        activePending = false
        activeChanges.clear()
      }
    }
  }

  function onEvent(event: ServerEvent) {
    if (event.type === 'session.updated') {
      if (activePending) activeChanges.set(event.session.id, event.session)
      if (recentPending) recentChanges.set(event.session.id, event.session)
      const next = { ...byId.value }
      if (isActive(event.session)) next[event.session.id] = event.session
      else delete next[event.session.id]
      byId.value = next
      revision.value++
      // keep the recent copy current until the refetch lands, so a row never shows a stale state
      if (recent.value.some(s => s.id === event.session.id))
        recent.value = event.session.aside
          ? recent.value.filter(s => s.id !== event.session.id)
          : recent.value.map(s => (s.id === event.session.id ? event.session : s))
      trackWork([event.session])
      if (!event.session.aside) refreshRecent()
    } else if (event.type === 'session.event' && event.event.type === 'task') {
      const known = tasksById.value[event.sessionId]
      const task = event.event.task
      const changes = pendingWork.get(event.sessionId)
      if (changes) changes[taskKey(task)] = task
      if (known || recent.value.some(s => s.id === event.sessionId))
        tasksById.value = {
          ...tasksById.value,
          [event.sessionId]: { ...known, [taskKey(task)]: task },
        }
    } else if (event.type === 'session.removed') {
      pendingWork.delete(event.sessionId)
      loadedAt.delete(event.sessionId)
      delete tasksById.value[event.sessionId]
      if (activePending) activeChanges.set(event.sessionId, null)
      if (recentPending) recentChanges.set(event.sessionId, null)
      const next = { ...byId.value }
      delete next[event.sessionId]
      byId.value = next
      recent.value = recent.value.filter(s => s.id !== event.sessionId)
      revision.value++
      refreshRecent()
    }
  }

  const active = computed(() => {
    const background = recent.value
      .filter(s => !byId.value[s.id] && workById.value[s.id])
      .map((s): Session => ({ ...s, state: 'running' }))
    return sidebarOrder([...Object.values(byId.value), ...background])
  })
  const sidebar = computed(() => {
    const merged = new Map(recent.value.map(s => [s.id, s]))
    for (const s of active.value) merged.set(s.id, s)
    return sidebarOrder([...merged.values()]).slice(0, SIDEBAR_LIMIT)
  })
  const waiting = computed(() => active.value.filter(s => s.state === 'waiting'))
  const running = computed(() => active.value.filter(s => s.state === 'running'))

  return {
    active,
    waiting,
    running,
    loading,
    error,
    revision,
    reload,
    countsFor: project => ({
      waiting: waiting.value.filter(s => (s.projects ?? [s.project]).includes(project)).length,
      running: running.value.filter(s => (s.projects ?? [s.project]).includes(project)).length,
    }),
    sidebar,
    recentPhase,
    reloadRecent,
    workOf: id => workById.value[id],
    start() {
      if (unsubscribe) return
      void reload()
      void reloadRecent()
      unsubscribe = api.subscribe(onEvent, () => {
        revision.value++
        void reload()
        void reloadRecent()
      })
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
      clearTimeout(recentTimer)
    },
  }
}
