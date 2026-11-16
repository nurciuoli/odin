<script lang="ts">
// shared across every mounted palette: the last entry owns ⌘K
const hotkeyOwners: symbol[] = []
</script>

<script setup lang="ts">
// IuCommandPalette.vue
// The bundle's extracted source only sketches the reactive core (query/
// cursor/prefix parsing, results, the global ⌘K + arrow/enter keydown
// handling) via `useEventListener` from @vueuse/core — a dependency this
// library doesn't have. That logic is kept exactly as given, just re-hosted
// on plain onMounted/onUnmounted + a native window listener. Everything
// else (the <dialog> shell, grouping/rendering, match highlighting, the
// prefix chip, debounce, empty state) is new, real implementation built to
// the API table + the "Default", "Querying" and "Prefix grammar" mockup
// sections.
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { IuIcon } from '@/components/Icon'
import type { IconName } from '@/components/Icon'

export interface CommandItem {
  id: string
  label: string
  icon?: IconName
  /** right-aligned meta text — an id, a relative time, a shortcut */
  hint?: string
  /** heading this item renders under when the query is empty (e.g. 'Recent' / 'Actions') */
  group?: string
  /** row stays visible but isn't selectable; the reason renders where `hint` would go */
  disabledReason?: string
}

export interface CommandSource {
  id: string
  /** a leading sigil ('>', '#', '@', '/', '?', …) that narrows the search to just this source */
  prefix?: string
  /** shown as the active-prefix chip while this source is the only one in scope */
  label: string
  resolve: (term: string) => CommandItem[]
}

const open = defineModel<boolean>('open', { default: false })
const props = withDefaults(
  defineProps<{
    sources: CommandSource[]
    /** shown, grouped, when the query is empty */
    recent?: CommandItem[]
    /** debounces re-filtering after each keystroke — async/expensive sources only */
    debounce?: number
    /** false leaves ⌘K/Ctrl+K to the app (its own shortcut registry); the palette then opens only through v-model:open */
    hotkey?: boolean
  }>(),
  { debounce: 120, hotkey: true },
)

const emit = defineEmits<{ select: [item: CommandItem, opts: { newTab: boolean }] }>()

const query = ref('')
const cursor = ref(0)

// --- debounce: the input shows every keystroke instantly, but the value
// that actually drives filtering trails behind by `debounce` ms (except
// clearing, which is instant) so `resolve()` isn't re-run on every key. ---
const debouncedQuery = ref('')
let debounceTimer: ReturnType<typeof setTimeout> | undefined
watch(
  query,
  v => {
    clearTimeout(debounceTimer)
    if (v === '') {
      debouncedQuery.value = ''
      return
    }
    debounceTimer = setTimeout(() => {
      debouncedQuery.value = v
    }, props.debounce)
  },
  { immediate: true },
)

// a leading sigil narrows the search to one source and becomes a chip
const PREFIXES = ['>', '#', '@', '/', '?'] as const
const prefix = computed(() => PREFIXES.find(p => debouncedQuery.value.startsWith(p)) ?? null)
const term = computed(() => (prefix.value ? debouncedQuery.value.slice(1) : debouncedQuery.value))
const activeSource = computed(() =>
  prefix.value ? (props.sources.find(s => s.prefix === prefix.value) ?? null) : null,
)

const results = computed(() => {
  if (!term.value && !prefix.value) return props.recent ?? []
  const pool = prefix.value ? props.sources.filter(s => s.prefix === prefix.value) : props.sources
  return pool.flatMap(s => s.resolve(term.value)).slice(0, 40)
})

watch(results, () => {
  cursor.value = 0
})

function choose(item: CommandItem | undefined, evt?: KeyboardEvent | MouseEvent) {
  if (!item || item.disabledReason) return
  emit('select', item, { newTab: !!evt && 'metaKey' in evt && evt.metaKey })
  open.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (results.value.length) cursor.value = (cursor.value + 1) % results.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (results.value.length)
      cursor.value = (cursor.value - 1 + results.value.length) % results.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    choose(results.value[cursor.value], e)
  } else if (e.key === 'Backspace' && prefix.value && !term.value) {
    e.preventDefault()
    query.value = ''
  }
}

// ⌘K/Ctrl+K toggles the palette globally, whether or not it's currently open.
// When several palettes are mounted at once (an app-level one plus a page-
// level one), only the most recently mounted answers the shortcut — the
// innermost context wins, and one keypress never opens two dialogs.
const hotkeyToken = Symbol('iu-cmdk')
function onGlobalKeydown(e: KeyboardEvent) {
  if (hotkeyOwners[hotkeyOwners.length - 1] !== hotkeyToken) return
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    open.value = !open.value
  }
}
onMounted(() => {
  if (!props.hotkey) return
  hotkeyOwners.push(hotkeyToken)
  window.addEventListener('keydown', onGlobalKeydown)
})
onUnmounted(() => {
  const i = hotkeyOwners.indexOf(hotkeyToken)
  if (i !== -1) hotkeyOwners.splice(i, 1)
  window.removeEventListener('keydown', onGlobalKeydown)
  clearTimeout(debounceTimer)
})

// --- dialog shell ---
const dialogEl = ref<HTMLDialogElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

watch(
  open,
  async v => {
    const dlg = dialogEl.value
    if (!dlg) return
    if (v) {
      if (!dlg.open) dlg.showModal()
      await nextTick()
      inputEl.value?.focus()
    } else {
      query.value = ''
      cursor.value = 0
      if (dlg.open) dlg.close()
    }
  },
  { immediate: true },
)

function onClose() {
  open.value = false
}
function onBackdropClick(e: MouseEvent) {
  if (e.target === dialogEl.value) open.value = false
}

// matched-substring highlighting for the label (simple, case-insensitive —
// the actual ranking/fuzzy-match lives in each source's resolve())
function matchParts(label: string, needle: string): { pre: string; match: string; post: string } {
  if (!needle) return { pre: label, match: '', post: '' }
  const i = label.toLowerCase().indexOf(needle.toLowerCase())
  if (i === -1) return { pre: label, match: '', post: '' }
  return {
    pre: label.slice(0, i),
    match: label.slice(i, i + needle.length),
    post: label.slice(i + needle.length),
  }
}
</script>

<template>
  <dialog ref="dialogEl" class="iu-cmdk" @close="onClose" @click="onBackdropClick">
    <div class="iu-cmdk__panel" @click.stop>
      <div class="iu-cmdk__row">
        <IuIcon name="search" :size="16" class="iu-cmdk__search-icon" />
        <span v-if="activeSource" class="iu-cmdk__prefix-chip">{{ activeSource.label }}</span>
        <input
          ref="inputEl"
          v-model="query"
          class="iu-cmdk__input"
          type="text"
          placeholder="Search or run a command…"
          autocomplete="off"
          spellcheck="false"
          @keydown="onKeydown"
        />
        <span v-if="term || prefix" class="iu-cmdk__count"
          >{{ results.length }} result{{ results.length === 1 ? '' : 's' }}</span
        >
        <span v-else class="iu-cmdk__kbd">esc</span>
      </div>

      <div class="iu-cmdk__list" role="listbox">
        <template v-if="results.length">
          <template v-for="(item, i) in results" :key="item.id">
            <div v-if="item.group && item.group !== results[i - 1]?.group" class="iu-cmdk__group">
              {{ item.group }}
            </div>
            <div
              class="iu-cmdk__row-item"
              :class="{ 'is-active': i === cursor, 'is-disabled': !!item.disabledReason }"
              role="option"
              :aria-selected="i === cursor"
              :aria-disabled="!!item.disabledReason || undefined"
              @mouseenter="cursor = i"
              @click="choose(item, $event)"
            >
              <IuIcon v-if="item.icon" :name="item.icon" :size="16" class="iu-cmdk__row-icon" />
              <span class="iu-cmdk__row-label">
                <template v-if="term"
                  >{{ matchParts(item.label, term).pre
                  }}<mark>{{ matchParts(item.label, term).match }}</mark
                  >{{ matchParts(item.label, term).post }}</template
                >
                <template v-else>{{ item.label }}</template>
              </span>
              <span v-if="item.disabledReason" class="iu-cmdk__row-hint">{{
                item.disabledReason
              }}</span>
              <span v-else-if="item.hint" class="iu-cmdk__row-hint iu-cmdk__row-hint--mono">{{
                item.hint
              }}</span>
            </div>
          </template>
        </template>
        <div v-else class="iu-cmdk__empty">
          <slot name="empty" :term="term">
            <div class="iu-cmdk__empty-title">No match for “{{ term }}”</div>
            <div class="iu-cmdk__empty-hint">
              Try a different search, or a prefix: {{ PREFIXES.join('  ') }}
            </div>
          </slot>
        </div>
      </div>

      <div class="iu-cmdk__footer">
        <span class="iu-cmdk__hint"><kbd>↑↓</kbd>navigate</span>
        <span class="iu-cmdk__hint"><kbd>↵</kbd>open</span>
        <span class="iu-cmdk__hint"><kbd>⌘↵</kbd>new tab</span>
      </div>
    </div>
  </dialog>
</template>

<style>
.iu-cmdk {
  border: none;
  margin: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  width: 100%;
  height: 100%;
  max-width: 100vw;
  max-height: 100vh;
  inset: 0;
  position: fixed;
}
.iu-cmdk[open] {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
}
.iu-cmdk::backdrop {
  background: var(--iu-scrim-light);
}

.iu-cmdk__panel {
  width: 100%;
  max-width: 560px;
  margin: 0 16px;
  display: flex;
  flex-direction: column;
  max-height: 70vh;
  background: var(--iu-surface);
  border: 1px solid var(--iu-border-strong);
  border-radius: var(--iu-radius-lg);
  box-shadow: var(--iu-shadow-dialog);
  overflow: hidden;
  font-family: var(--iu-font-sans);
  color: var(--iu-text);
}

.iu-cmdk__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--iu-hairline);
  flex: none;
}
.iu-cmdk__search-icon {
  color: var(--iu-text-muted);
  flex: none;
}
.iu-cmdk__prefix-chip {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-accent);
  background: var(--iu-accent-wash);
  border: 1px solid var(--iu-accent-border);
  border-radius: var(--iu-radius-sm);
  padding: 2px 6px;
}
.iu-cmdk__input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: 15px;
  color: var(--iu-text);
}
.iu-cmdk__input::placeholder {
  color: var(--iu-text-disabled);
}
.iu-cmdk__count,
.iu-cmdk__kbd {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.iu-cmdk__kbd {
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  padding: 1px 6px;
}

.iu-cmdk__list {
  padding: 8px 0;
  overflow-y: auto;
}
.iu-cmdk__group {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-disabled);
  padding: 8px 16px 6px;
}
.iu-cmdk__row-item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 8px 16px;
  cursor: pointer;
  position: relative;
}
.iu-cmdk__row-item.is-active {
  background: var(--iu-raised);
}
.iu-cmdk__row-item.is-active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--iu-accent);
}
.iu-cmdk__row-item.is-disabled {
  cursor: default;
  opacity: 0.45;
}
.iu-cmdk__row-icon {
  flex: none;
  color: var(--iu-text-muted);
}
.iu-cmdk__row-item.is-active .iu-cmdk__row-icon {
  color: var(--iu-accent);
}
.iu-cmdk__row-label {
  flex: 1;
  min-width: 0;
  font-size: var(--iu-font-size-14);
  color: var(--iu-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.iu-cmdk__row-label mark {
  background: var(--iu-accent-wash);
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-semibold);
  border-radius: 2px;
  padding: 0 1px;
}
.iu-cmdk__row-hint {
  flex: none;
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}
.iu-cmdk__row-hint--mono {
  font-family: var(--iu-font-mono);
}

.iu-cmdk__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 10px 16px 18px;
}
.iu-cmdk__empty-title {
  font-size: var(--iu-font-size-14);
  color: var(--iu-text);
}
.iu-cmdk__empty-hint {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
  line-height: var(--iu-leading-relaxed);
  font-family: var(--iu-font-mono);
}

.iu-cmdk__footer {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 9px 16px;
  border-top: 1px solid var(--iu-hairline);
  background: var(--iu-surface-sunken);
  flex: none;
}
.iu-cmdk__hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.iu-cmdk__hint kbd {
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  padding: 0 5px;
  font: inherit;
}
</style>
