// What the sky over the flock should react to: how many sessions are running, and a counter that ticks when one
// finishes or starts waiting for you. Derived from the app-wide sessions store, which only holds running and waiting
// sessions, so a session that leaves it has finished (or was removed).
import { computed, inject, ref, watch } from 'vue'
import { SESSIONS_KEY } from '@/app/sessions'
import type { FlashKind } from './storm'

export function useStormSignal() {
  // optional: a form mounted without the app shell (tests) just has a clear sky
  const live = inject(SESSIONS_KEY, null)
  const running = computed(() => live?.running.value.length ?? 0)
  const signal = ref<{ id: number; kind: FlashKind } | null>(null)
  let count = 0
  let before = new Map<string, string>()
  if (live)
    watch(
      () => live.active.value.map(s => [s.id, s.state] as const),
      next => {
        const now = new Map(next)
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
  return { running, signal }
}
