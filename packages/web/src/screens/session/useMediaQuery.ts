import { onBeforeUnmount, ref, type Ref } from 'vue'

/** Whether a media query matches, kept up to date. False where there's no `matchMedia` (tests, SSR). */
export function useMediaQuery(query: string): Ref<boolean> {
  const mq =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null
  const matches = ref(mq?.matches ?? false)
  const onChange = (e: MediaQueryListEvent) => (matches.value = e.matches)
  mq?.addEventListener?.('change', onChange)
  onBeforeUnmount(() => mq?.removeEventListener?.('change', onChange))
  return matches
}
