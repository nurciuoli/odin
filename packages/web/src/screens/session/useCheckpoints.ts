// A session's checkpoints (one per user message, docs/contracts.md#checkpoints): loaded once, then kept current by
// `checkpoint.updated` frames. Empty when the session has none (checkpoints off, or an imported session).
import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import type { Checkpoint } from '@odin/shared/api'
import { useApi } from '@/api'

export function useCheckpoints(id: Ref<string>) {
  const api = useApi()
  const checkpoints = ref<Checkpoint[]>([])
  let latest = 0

  async function load() {
    const token = ++latest
    try {
      const list = await api.listCheckpoints(id.value)
      if (token === latest) checkpoints.value = list
    } catch {
      if (token === latest) checkpoints.value = []
    }
  }

  let off: (() => void) | null = null
  onMounted(() => {
    off = api.subscribe(
      event => {
        if (event.type !== 'checkpoint.updated' || event.sessionId !== id.value) return
        const others = checkpoints.value.filter(c => c.id !== event.checkpoint.id)
        checkpoints.value = [...others, event.checkpoint].sort((a, b) => a.turn - b.turn)
      },
      () => void load(),
    )
  })
  onBeforeUnmount(() => {
    off?.()
    off = null
    latest++
  })
  watch(
    id,
    () => {
      checkpoints.value = []
      void load()
    },
    { immediate: true },
  )

  /** Turn checkpoints by the user message they precede. */
  const byMessage = computed(
    () =>
      new Map(
        checkpoints.value
          .filter(c => c.kind === 'turn' && c.messageId)
          .map(c => [c.messageId!, c] as const),
      ),
  )
  return { checkpoints, byMessage, reload: load }
}

/** "3 files changed", "no file changes", or null while the turn is still running. */
export function checkpointSummary(c: Checkpoint): string | null {
  if (c.snapshot !== 'ok')
    return c.snapshot === 'skipped' ? 'files not saved (too large)' : 'files not saved'
  if (!c.files) return null
  const n = c.files.changed + c.files.added + c.files.removed
  return n === 0 ? 'no file changes' : `${n} ${n === 1 ? 'file' : 'files'} changed`
}
