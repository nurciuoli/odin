// useToast.ts — a module-level store, no provider needed. Bottom-right
// stack, newest on top, maximum three visible (the extra slots the store
// keeps around beyond MAX just back the "+N more" overflow hint).
import { shallowRef } from 'vue'
import type { IconName } from '@/components/Icon'

export interface ToastOptions {
  title: string
  description?: string
  intent?: 'success' | 'warning' | 'danger' | 'info' | 'progress'
  duration?: number | null
  action?: { label: string; onClick: () => void }
  dedupeKey?: string
}

export interface Toast extends ToastOptions {
  id: string
  count: number
  duration: number | null
}

const items = shallowRef<Toast[]>([])
const MAX = 3
/** how many extra items the store keeps queued past MAX, for the overflow hint */
const OVERFLOW_SLACK = 2
export const MAX_VISIBLE = MAX

function defaultDuration(
  intent: ToastOptions['intent'],
  requested: number | null | undefined,
): number | null {
  if (intent === 'danger' || intent === 'progress') return null
  return requested ?? 5000
}

// --- per-toast auto-dismiss timers, pause/resume-with-remaining-time ---
interface TimerState {
  remaining: number
  startedAt: number
  handle: ReturnType<typeof setTimeout> | null
}
const timers = new Map<string, TimerState>()

function clearTimer(id: string) {
  const t = timers.get(id)
  if (t?.handle) clearTimeout(t.handle)
  timers.delete(id)
}

function schedule(id: string, ms: number) {
  clearTimer(id)
  timers.set(id, {
    remaining: ms,
    startedAt: Date.now(),
    handle: setTimeout(() => dismiss(id), ms),
  })
}

function pause(id: string) {
  const t = timers.get(id)
  if (!t || t.handle === null) return
  clearTimeout(t.handle)
  t.remaining -= Date.now() - t.startedAt
  t.handle = null
}

function resume(id: string) {
  const t = timers.get(id)
  if (!t || t.handle !== null) return
  if (t.remaining <= 0) {
    dismiss(id)
    return
  }
  t.startedAt = Date.now()
  t.handle = setTimeout(() => dismiss(id), t.remaining)
}

/** icon for each intent — used by IuToaster instead of a literal glyph character */
export function glyph(intent: ToastOptions['intent']): IconName {
  switch (intent) {
    case 'success':
      return 'check'
    case 'warning':
      return 'alert'
    case 'danger':
      return 'alert'
    case 'progress':
      return 'clock'
    case 'info':
    default:
      return 'info'
  }
}

export function useToast() {
  function toast(o: ToastOptions): string {
    const existing = o.dedupeKey && items.value.find(t => t.dedupeKey === o.dedupeKey)
    if (existing) {
      items.value = items.value.map(t => (t.id === existing.id ? { ...t, count: t.count + 1 } : t))
      return existing.id
    }

    const id = crypto.randomUUID()
    const duration = defaultDuration(o.intent, o.duration)
    const next = [{ ...o, id, count: 1, duration }, ...items.value]
    const dropped = next.slice(MAX + OVERFLOW_SLACK)
    dropped.forEach(t => clearTimer(t.id))
    items.value = next.slice(0, MAX + OVERFLOW_SLACK)
    if (duration) schedule(id, duration)
    return id
  }

  /** patch a toast in place — e.g. progress → success without a new toast */
  function update(id: string, patch: Partial<ToastOptions>) {
    const idx = items.value.findIndex(t => t.id === id)
    if (idx === -1) return
    const current = items.value[idx]

    let duration = current.duration
    if ('duration' in patch) {
      duration = patch.duration ?? null
    } else if (patch.intent && patch.intent !== current.intent) {
      duration = defaultDuration(patch.intent, undefined)
    }

    const merged: Toast = { ...current, ...patch, duration }
    const next = [...items.value]
    next[idx] = merged
    items.value = next

    if (duration) schedule(id, duration)
    else clearTimer(id)
  }

  return { items, toast, update, dismiss, pause, resume }
}

function dismiss(id: string) {
  clearTimer(id)
  items.value = items.value.filter(t => t.id !== id)
}
