// What the sky over Home should react to. `active` is whether there is weather: it turns on the moment a session is
// running or waiting for you, stays on while a session this page watched start is finished but still unread, and
// turns off `STORM.lag` seconds after the last of them has been read. `signal` ticks when a session finishes or
// starts waiting for you. Derived from the app-wide sessions store, which only holds running and waiting sessions, so
// a session that leaves it has finished (or was removed).
import { computed, inject, onScopeDispose, reactive, ref, watch } from 'vue'
import { SESSIONS_KEY } from '@/app/sessions'
import { isUnread } from '@/app/seen'
import { STORM, type FlashKind } from './storm'

export function useStormSignal(lagSeconds = STORM.lag) {
  // optional: a form mounted without the app shell (tests) just has a clear sky
  const live = inject(SESSIONS_KEY, null)
  const active = ref(false)
  const signal = ref<{ id: number; kind: FlashKind } | null>(null)
  if (!live) return { active, signal }
  // sessions seen running or waiting since this page opened; an old unread session doesn't summon a storm
  const touched = reactive(new Set<string>())
  const engaged = computed(
    () =>
      live.active.value.length > 0 ||
      live.sidebar.value.some(s => touched.has(s.id) && isUnread(s)),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  watch(
    [engaged, () => live.loading.value],
    ([on, loading]) => {
      if (loading) return
      if (on) {
        clearTimeout(timer)
        timer = undefined
        active.value = true
      } else if (active.value && !timer) {
        timer = setTimeout(() => {
          timer = undefined
          active.value = false
        }, lagSeconds * 1000)
      }
    },
    { immediate: true },
  )
  let count = 0
  let before = new Map<string, string>()
  watch(
    () => live.active.value.map(s => [s.id, s.state] as const),
    next => {
      const now = new Map(next)
      for (const id of now.keys()) touched.add(id)
      // the first list is the baseline, not news
      if (!live.loading.value) {
        let kind: FlashKind | null = null
        for (const [id, state] of now)
          if (state === 'waiting' && before.get(id) !== 'waiting') kind = 'attention'
        if (!kind) for (const id of before.keys()) if (!now.has(id)) kind = 'done'
        if (kind) signal.value = { id: ++count, kind }
      }
      before = now
    },
    { immediate: true },
  )
  onScopeDispose(() => clearTimeout(timer))
  return { active, signal }
}
