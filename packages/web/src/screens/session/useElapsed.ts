// One shared 1s clock for the elapsed time on running steps. Ticks only while something is running.
import { onScopeDispose, ref, watch, type Ref } from 'vue'

export function useElapsed(active: () => boolean): Ref<number | undefined> {
  const now = ref<number | undefined>(undefined)
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  watch(
    active,
    on => {
      stop()
      if (!on) return
      now.value = Date.now()
      timer = setInterval(() => (now.value = Date.now()), 1000)
    },
    { immediate: true },
  )
  onScopeDispose(stop)
  return now
}
