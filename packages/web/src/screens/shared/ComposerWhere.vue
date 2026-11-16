<script setup lang="ts">
// Where the session runs: this checkout, or a new worktree (optionally on a named branch). One quiet chip in the
// composer toolbar that opens a small popover. It never opens on its own focus-wise: focus moves in only when you
// open it yourself.
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { branchProblem, slugFromPrompt } from './newSessionForm'

const props = withDefaults(
  defineProps<{
    /** The message being written; the auto branch name previews a slug of it. */
    prompt?: string
    /** Branch prefixes used lately (`feat/`), offered as extra suggestions. */
    recentPrefixes?: string[]
    disabled?: boolean
    /** Shortcut hint for the chip's tooltip. */
    shortcut?: string
  }>(),
  { prompt: '', recentPrefixes: () => [], disabled: false, shortcut: '' },
)
const worktree = defineModel<boolean>('worktree', { default: false })
const branch = defineModel<string>('branch', { default: '' })
const open = defineModel<boolean>('open', { default: false })

const id = useId()
const root = ref<HTMLElement | null>(null)
const chip = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const active = ref(-1)

const slug = computed(() => slugFromPrompt(props.prompt))
const label = computed(() =>
  worktree.value ? `New worktree · ${branch.value.trim() || 'auto'}` : 'This checkout',
)
const problem = computed(() => (worktree.value ? branchProblem(branch.value) : undefined))
const placeholder = computed(() => slug.value || 'Chosen for you')
const suggestions = computed(() => {
  if (!slug.value) return []
  const list = [slug.value, ...props.recentPrefixes.map(p => `${p}${slug.value}`)]
  return [...new Set(list)].filter(s => !branchProblem(s)).slice(0, 3)
})
watch(suggestions, () => (active.value = -1))

function focusChip() {
  chip.value?.querySelector<HTMLElement>('button')?.focus()
}
function close(restoreFocus = true) {
  if (!open.value) return
  open.value = false
  active.value = -1
  if (restoreFocus) void nextTick(focusChip)
}
async function toggle() {
  if (open.value) return close()
  open.value = true
  // the user asked for it, so focus may move in
  await nextTick()
  if (worktree.value) input.value?.focus()
  else root.value?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus()
}
function choose(next: boolean) {
  worktree.value = next
  if (next) void nextTick(() => input.value?.focus())
}
function pick(value: string) {
  branch.value = value
  close()
}
function onInputKey(e: KeyboardEvent) {
  const count = suggestions.value.length
  if (e.key === 'ArrowDown' && count) {
    e.preventDefault()
    active.value = (active.value + 1) % count
  } else if (e.key === 'ArrowUp' && count) {
    e.preventDefault()
    active.value = active.value <= 0 ? count - 1 : active.value - 1
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const chosen = suggestions.value[active.value]
    if (chosen) pick(chosen)
    else if (!problem.value) close()
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    e.stopPropagation()
    close()
  }
}
function onFocusout(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (open.value && next && !root.value?.contains(next)) close(false)
}
function onPointerdown(e: PointerEvent) {
  if (open.value && !root.value?.contains(e.target as Node)) close(false)
}
watch(open, value => {
  if (value) document.addEventListener('pointerdown', onPointerdown)
  else document.removeEventListener('pointerdown', onPointerdown)
})
onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerdown))

const options = [
  { value: false, title: 'This checkout', hint: 'Work directly in the repository as it is' },
  { value: true, title: 'New worktree', hint: 'Work on a separate branch in its own folder' },
]
</script>

<template>
  <div ref="root" class="composer-where" @keydown="onKeydown" @focusout="onFocusout">
    <span ref="chip" class="composer-where__chip">
      <IuButton
        variant="ghost"
        size="sm"
        :aria-label="`Where it runs: ${label}`"
        :title="shortcut ? `Toggle with ${shortcut}` : undefined"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-controls="open ? `${id}-pop` : undefined"
        :disabled="disabled"
        @click="toggle"
      >
        <template #icon><IuIcon name="gitBranch" :size="14" /></template>
        {{ label }}
        <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
      </IuButton>
    </span>
    <div
      v-if="open"
      :id="`${id}-pop`"
      class="composer-where__pop"
      role="dialog"
      aria-label="Where this session runs"
    >
      <button
        v-for="o in options"
        :key="String(o.value)"
        type="button"
        class="composer-where__option"
        :aria-pressed="worktree === o.value"
        @click="choose(o.value)"
      >
        <span class="composer-where__mark" aria-hidden="true">{{
          worktree === o.value ? '●' : '○'
        }}</span>
        <span class="composer-where__text">
          <span class="composer-where__title">{{ o.title }}</span>
          <span class="composer-where__hint">{{ o.hint }}</span>
        </span>
      </button>
      <div v-if="worktree" class="composer-where__branch">
        <label :for="`${id}-branch`" class="composer-where__label">Branch name</label>
        <input
          :id="`${id}-branch`"
          ref="input"
          v-model="branch"
          class="composer-where__input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="placeholder"
          :aria-invalid="!!problem || undefined"
          :aria-describedby="`${id}-msg`"
          :aria-activedescendant="active >= 0 ? `${id}-s${active}` : undefined"
          @keydown="onInputKey"
        />
        <ul v-if="suggestions.length" class="composer-where__suggestions" aria-label="Suggestions">
          <li v-for="(s, i) in suggestions" :id="`${id}-s${i}`" :key="s">
            <button
              type="button"
              class="composer-where__suggestion"
              :class="{ 'composer-where__suggestion--active': i === active }"
              tabindex="-1"
              @click="pick(s)"
            >
              {{ s }}
            </button>
          </li>
        </ul>
        <p :id="`${id}-msg`" class="composer-where__message" role="status" aria-live="polite">
          <span v-if="problem" class="composer-where__error">{{ problem }}</span>
          <template v-else>Empty picks a name from your message.</template>
        </p>
      </div>
    </div>
  </div>
</template>

<style>
.composer-where {
  position: relative;
  display: inline-flex;
}
.composer-where__chip {
  display: inline-flex;
}
.composer-where__pop {
  position: absolute;
  bottom: 100%;
  left: 0;
  z-index: 30;
  margin-bottom: 6px;
  width: 300px;
  max-width: 90vw;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--iu-raised);
  border: 1px solid var(--iu-border-strong);
  border-radius: var(--iu-radius-lg);
  box-shadow: var(--iu-shadow-popover);
  text-align: left;
}
.composer-where__option {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 100%;
  padding: 8px;
  border: 0;
  border-radius: var(--iu-radius-md);
  background: transparent;
  color: var(--iu-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.composer-where__option:hover {
  background: var(--iu-hover);
}
.composer-where__option[aria-pressed='true'] {
  background: var(--iu-accent-wash);
}
.composer-where__option:focus-visible,
.composer-where__suggestion:focus-visible,
.composer-where__input:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.composer-where__mark {
  color: var(--iu-accent);
  font-size: var(--iu-font-size-12);
}
.composer-where__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.composer-where__title {
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
}
.composer-where__hint {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.composer-where__branch {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 8px 4px;
  border-top: 1px solid var(--iu-border);
  margin-top: 4px;
}
.composer-where__label {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.composer-where__input {
  box-sizing: border-box;
  width: 100%;
  padding: 6px 8px;
  background: var(--iu-surface-sunken);
  color: var(--iu-text);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
}
.composer-where__input[aria-invalid='true'] {
  border-color: var(--iu-danger);
}
.composer-where__suggestions {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.composer-where__suggestion {
  width: 100%;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text-2);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  text-align: left;
  cursor: pointer;
}
.composer-where__suggestion:hover,
.composer-where__suggestion--active {
  background: var(--iu-hover);
  color: var(--iu-text);
}
.composer-where__suggestion--active {
  outline: 1px solid var(--iu-border-strong);
}
.composer-where__message {
  margin: 0;
  min-height: 1lh;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.composer-where__error {
  color: var(--iu-danger);
}
@media (prefers-reduced-motion: no-preference) {
  .composer-where__option {
    transition: background-color 0.12s;
  }
}
</style>
