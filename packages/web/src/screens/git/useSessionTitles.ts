// Session titles for commits that carry an `Odin-Session` trailer, fetched once per id and shared by every view.
import { reactive } from 'vue'
import { useApi } from '@/api'

const cache = reactive(new Map<string, string | null>())

export function useSessionTitles() {
  const api = useApi()
  return {
    /** Starts fetching a title (once per id). */
    want(id: string) {
      if (cache.has(id)) return
      cache.set(id, null)
      api.getSession(id).then(
        s => cache.set(id, s.title),
        () => cache.set(id, null),
      )
    },
    title: (id: string): string | null => cache.get(id) ?? null,
  }
}
