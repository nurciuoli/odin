// useCopy — clipboard write with a short-lived "copied" flag for the check
// icon / sr-only announcement. Shared by code blocks, diffs and chat messages.
import { onBeforeUnmount, ref } from 'vue'

export function useCopy(resetMs = 1500) {
  const copied = ref(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  async function copy(text: string): Promise<boolean> {
    if (!navigator.clipboard) return false
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      return false // permission denied or insecure context: say nothing rather than claim success
    }
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      copied.value = false
    }, resetMs)
    return true
  }

  onBeforeUnmount(() => clearTimeout(timer))
  return { copied, copy }
}
