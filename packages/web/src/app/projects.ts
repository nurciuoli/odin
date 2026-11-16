// The project list the shell and the Projects screen share, kept live from the event stream. One subscription for
// the whole app (subscribe once in the shell); screens that load a single project watch
// `revision(name)` to know when to refetch it.
import { inject, reactive, ref, type InjectionKey, type Ref } from 'vue'
import type { ProjectSummary } from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import type { Api } from '@/api/types'

export interface ProjectsStore {
  projects: Ref<ProjectSummary[]>
  /** true until the first list (or failure) arrives */
  loading: Ref<boolean>
  error: Ref<string | null>
  reload(): Promise<void>
  /** Bumps whenever `project.updated` arrives for the project, or after a reconnect. Watch it to refetch. */
  revision(name: string): number
  start(): void
  stop(): void
}

export const PROJECTS_KEY: InjectionKey<ProjectsStore> = Symbol('odin-projects')

export function useProjects(): ProjectsStore {
  const store = inject(PROJECTS_KEY, null)
  if (!store) throw new Error('useProjects() needs the app shell to provide the project store')
  return store
}

/** Events that change what a project card shows (session counts) without saying "project.updated". */
const COUNT_EVENTS = new Set<ServerEvent['type']>(['session.removed'])

export function createProjectsStore(api: Api, debounceMs = 120): ProjectsStore {
  const projects = ref<ProjectSummary[]>([])
  const loading = ref(true)
  const error = ref<string | null>(null)
  const revisions = reactive<Record<string, number>>({})
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let request = 0
  let held: ServerEvent[] | null = null

  async function reload() {
    const token = ++request
    held = []
    try {
      let list = await api.listProjects()
      if (token !== request) return
      for (const event of held ?? []) {
        if (event.type === 'project.removed') list = list.filter(p => p.name !== event.project)
        else if (event.type === 'sync.status')
          list = list.map(p => (p.name === event.project ? { ...p, sync: event.sync } : p))
      }
      projects.value = list
      error.value = null
    } catch (e) {
      if (token !== request) return
      error.value = e instanceof Error ? e.message : String(e)
    } finally {
      if (token === request) {
        held = null
        loading.value = false
      }
    }
  }

  // Several events usually arrive together (a session ending touches the session and project): one refetch.
  function scheduleReload() {
    clearTimeout(timer)
    timer = setTimeout(() => void reload(), debounceMs)
  }

  function bump(name: string) {
    revisions[name] = (revisions[name] ?? 0) + 1
  }

  function onEvent(event: ServerEvent) {
    if (held) held.push(event)
    if (event.type === 'project.updated') {
      bump(event.project)
      scheduleReload()
    } else if (event.type === 'project.removed') {
      projects.value = projects.value.filter(p => p.name !== event.project)
    } else if (event.type === 'sync.status') {
      projects.value = projects.value.map(p =>
        p.name === event.project ? { ...p, sync: event.sync } : p,
      )
    } else if (COUNT_EVENTS.has(event.type)) {
      scheduleReload()
    }
  }

  return {
    projects,
    loading,
    error,
    reload,
    revision: name => revisions[name] ?? 0,
    start() {
      if (unsubscribe) return
      void reload()
      unsubscribe = api.subscribe(onEvent, () => {
        for (const name of new Set([...Object.keys(revisions), ...projects.value.map(p => p.name)]))
          bump(name)
        void reload()
      })
    },
    stop() {
      unsubscribe?.()
      unsubscribe = null
      clearTimeout(timer)
    },
  }
}
