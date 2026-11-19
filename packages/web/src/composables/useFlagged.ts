import { onBeforeUnmount, ref, type Ref } from 'vue'

/**
 * A set of keys that were flagged a moment ago, each cleared again after `ms`. Drives one-shot moments (a raven
 * landing, a merged shimmer) that must not replay when a screen is simply opened.
 */
export function useFlagged<K>(ms = 2500) {
  const flagged = ref(new Set<K>()) as Ref<Set<K>>
  const timers = new Set<ReturnType<typeof setTimeout>>()
  function flag(key: K) {
    flagged.value = new Set(flagged.value).add(key)
    const t = setTimeout(() => {
      timers.delete(t)
      const next = new Set(flagged.value)
      next.delete(key)
      flagged.value = next
    }, ms)
    timers.add(t)
  }
  onBeforeUnmount(() => timers.forEach(clearTimeout))
  return { flagged, flag }
}
