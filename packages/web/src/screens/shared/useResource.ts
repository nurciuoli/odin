// Load-and-refetch state for a screen's main request: loading → ready | error, and a failed refetch keeps showing
// what was already there (only a first load becomes an error page). Shared by screens
// with one main request.
import { onBeforeUnmount, onMounted, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import type { ServerEvent } from '@odin/shared/events'
import { ApiRequestError, useApi } from '@/api'

export type Phase = 'loading' | 'ready' | 'error'

export interface LoadError {
  status: number
  message: string
}

export interface Resource<T> {
  data: ShallowRef<T | null>
  phase: Ref<Phase>
  error: Ref<LoadError | null>
  /** Fetch again. A newer call wins over an older one that is still in flight. */
  load(): Promise<void>
  /** Back to the loading state, e.g. when the route points at another record. */
  reset(): void
}

export function useResource<T>(fetcher: () => Promise<T>): Resource<T> {
  const data = shallowRef<T | null>(null)
  const phase = ref<Phase>('loading')
  const error = ref<LoadError | null>(null)
  let latest = 0

  async function load() {
    const id = ++latest
    try {
      const next = await fetcher()
      if (id !== latest) return
      data.value = next
      phase.value = 'ready'
      error.value = null
    } catch (e) {
      if (id !== latest) return
      if (phase.value !== 'ready') {
        error.value = {
          status: e instanceof ApiRequestError ? e.status : 0,
          message: e instanceof Error ? e.message : String(e),
        }
        phase.value = 'error'
      }
    }
  }

  function reset() {
    latest++
    data.value = null
    phase.value = 'loading'
    error.value = null
  }

  return { data, phase, error, load, reset }
}

/** Listen to the server's event stream while the screen is mounted; `onReconnect` is the cue to refetch. */
export function useServerEvents(handler: (event: ServerEvent) => void, onReconnect?: () => void) {
  const api = useApi()
  let off: (() => void) | null = null
  onMounted(() => {
    off = api.subscribe(handler, onReconnect)
  })
  onBeforeUnmount(() => {
    off?.()
    off = null
  })
}

/** Replace the row with the same id, or add it. */
export function upsertById<T extends { id: number }>(list: T[], row: T): T[] {
  return list.some(r => r.id === row.id)
    ? list.map(r => (r.id === row.id ? row : r))
    : [...list, row]
}
