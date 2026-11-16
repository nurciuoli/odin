// useListbox.ts — headless core shared by every select/combobox surface.
// Owns query/open/active-index state, filtering, roving focus and (when
// `options` is an async function) request state — the wrapper component
// only has to render `visible`/`selected`/`pending` and forward DOM events
// into `onKeydown`.
import { computed, ref, unref, watch, type Ref } from 'vue'

export interface UseListboxOptions<T> {
  /** static option list, or an async lookup keyed by the current query */
  options: Ref<T[]> | ((query: string) => Promise<T[]>)
  /** allow more than one selected option; commit() then toggles membership
   *  and keeps the panel open instead of closing it */
  multiple?: boolean
  /** stable identity for an option — used for selection/active comparisons */
  key: (option: T) => string | number
  /** override the default case-insensitive substring filter */
  filter?: (options: T[], query: string) => T[]
  /** back the selection with an external ref (e.g. a defineModel()) instead
   *  of an internal one, so a wrapper component can expose it as v-model */
  selected?: Ref<T[]>
}

function stringify(option: unknown): string {
  if (option == null) return ''
  if (typeof option === 'string' || typeof option === 'number') return String(option)
  if (typeof option === 'object') {
    const rec = option as Record<string, unknown>
    for (const field of ['label', 'name', 'title', 'value']) {
      const v = rec[field]
      if (typeof v === 'string' || typeof v === 'number') return String(v)
    }
    try {
      return JSON.stringify(option)
    } catch {
      return ''
    }
  }
  return String(option)
}

function defaultFilter<T>(options: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return options
  return options.filter(o => stringify(o).toLowerCase().includes(q))
}

export function useListbox<T>(opts: UseListboxOptions<T>) {
  const query = ref('')
  const open = ref(false)
  const activeIndex = ref(-1)
  const selected = opts.selected ?? (ref<T[]>([]) as Ref<T[]>)
  const pending = ref(false)

  const isAsync = typeof opts.options === 'function'
  const asyncResults = ref<T[]>([]) as Ref<T[]>
  let requestId = 0

  async function runAsync(q: string) {
    if (!isAsync) return
    const thisRequest = ++requestId
    pending.value = true
    try {
      const results = await (opts.options as (q: string) => Promise<T[]>)(q)
      if (thisRequest === requestId) asyncResults.value = results
    } finally {
      if (thisRequest === requestId) pending.value = false
    }
  }

  if (isAsync) {
    watch(query, q => {
      runAsync(q)
    })
  }

  const visible = computed(() => {
    if (isAsync) return asyncResults.value
    const source = unref(opts.options as Ref<T[]>)
    const fn = opts.filter ?? defaultFilter
    return fn(source, query.value)
  })

  function isSelected(option: T): boolean {
    return selected.value.some(s => opts.key(s) === opts.key(option))
  }

  function move(delta: number) {
    const n = visible.value.length
    if (!n) {
      activeIndex.value = -1
      return
    }
    activeIndex.value = (activeIndex.value + delta + n) % n
  }

  function commit(option: T | undefined) {
    if (option === undefined) return
    if (opts.multiple) {
      selected.value = isSelected(option)
        ? selected.value.filter(s => opts.key(s) !== opts.key(option))
        : [...selected.value, option]
      // stays open so more than one option can be picked
    } else {
      selected.value = [option]
      close()
    }
  }

  function remove(option: T) {
    selected.value = selected.value.filter(s => opts.key(s) !== opts.key(option))
  }

  function close() {
    open.value = false
    activeIndex.value = -1
  }

  function openList() {
    if (open.value) return
    open.value = true
    const firstSelected = visible.value.findIndex(o => isSelected(o))
    activeIndex.value = firstSelected
    if (isAsync) runAsync(query.value)
  }

  function toggle() {
    if (open.value) close()
    else openList()
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open.value) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter') {
        openList()
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Enter') commit(visible.value[activeIndex.value])
    else if (e.key === 'Escape') close()
    else if (e.key === 'Home') activeIndex.value = visible.value.length ? 0 : -1
    else if (e.key === 'End') activeIndex.value = visible.value.length - 1
    else return
    e.preventDefault()
  }

  return {
    query,
    open,
    activeIndex,
    selected,
    pending,
    visible,
    isAsync,
    isSelected,
    move,
    commit,
    remove,
    close,
    openList,
    toggle,
    onKeydown,
  }
}

export type Listbox<T> = ReturnType<typeof useListbox<T>>
