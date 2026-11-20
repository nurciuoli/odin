<script setup lang="ts">
// Where the session runs, said exactly: the project's checkout (with its branch), an existing worktree, an existing
// branch (in a new worktree) or a new worktree on a fresh branch. One quiet chip beside the project and harness pickers
// that opens a small popover. It never opens on its own focus-wise: focus moves in only when you open it yourself.
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import type { ProjectBranch, ProjectWorktree, ProjectWorktrees } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { statusIntent } from '@/styles/status'
import { branchProblem, slugFromPrompt, type ExistingWhere } from './newSessionForm'

const props = withDefaults(
  defineProps<{
    /** The message being written; the auto branch name previews a slug of it. */
    prompt?: string
    /** Branch prefixes used lately (`feat/`), offered as extra suggestions. */
    recentPrefixes?: string[]
    disabled?: boolean
    /** Shortcut hint for the chip's tooltip. */
    shortcut?: string
    /** The project's checkout and worktrees; null without a project, before it loads, or when it is not a repo. */
    info?: ProjectWorktrees | null
    /** The project's local branches, for the branch filter. */
    branches?: ProjectBranch[]
    /** Remote branches (`origin/x`) with no local branch of the same name. */
    remoteBranches?: string[]
  }>(),
  {
    prompt: '',
    recentPrefixes: () => [],
    disabled: false,
    shortcut: '',
    info: null,
    branches: () => [],
    remoteBranches: () => [],
  },
)
const worktree = defineModel<boolean>('worktree', { default: false })
const branch = defineModel<string>('branch', { default: '' })
const existing = defineModel<ExistingWhere | null>('existing', { default: null })
const open = defineModel<boolean>('open', { default: false })

const id = useId()
const root = ref<HTMLElement | null>(null)
const chip = ref<HTMLElement | null>(null)
const pop = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const active = ref(-1)
const filter = ref('')
const branchActive = ref(-1)

const folder = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path
const main = computed(() => props.info?.worktrees.find(w => w.main) ?? null)
const others = computed(() => props.info?.worktrees.filter(w => !w.main) ?? [])
const mainName = computed(() => props.info?.mainBranch ?? main.value?.branch ?? 'detached')

type Kind = 'checkout' | 'new-worktree' | 'worktree' | 'branch'
const kind = computed<Kind>(
  () => existing.value?.kind ?? (worktree.value ? 'new-worktree' : 'checkout'),
)
const chosenPath = computed(() => (existing.value?.kind === 'worktree' ? existing.value.path : ''))
const chosenBranch = computed(() =>
  existing.value?.kind === 'branch' ? existing.value.branch : '',
)
const slug = computed(() => slugFromPrompt(props.prompt))
const dirty = computed(() => kind.value === 'checkout' && !!main.value?.dirty)
const label = computed(() => {
  switch (kind.value) {
    case 'new-worktree':
      return `New worktree · ${branch.value.trim() || 'auto'}`
    case 'branch':
      return `⎇ ${chosenBranch.value} · new worktree`
    case 'worktree': {
      const name = others.value.find(w => w.path === chosenPath.value)?.branch
      return name ? `⎇ ${name} · ${folder(chosenPath.value)}` : folder(chosenPath.value)
    }
    default:
      return props.info ? `⎇ ${mainName.value}` : 'This checkout'
  }
})
const fullPath = computed(() => {
  if (kind.value === 'checkout') return main.value?.path
  if (kind.value === 'worktree') return chosenPath.value
  return undefined
})
const chipTitle = computed(
  () =>
    [fullPath.value, props.shortcut ? `Toggle with ${props.shortcut}` : '']
      .filter(Boolean)
      .join('\n') || undefined,
)
const problem = computed(() =>
  kind.value === 'new-worktree' ? branchProblem(branch.value) : undefined,
)
const placeholder = computed(() => slug.value || 'Chosen for you')
const suggestions = computed(() => {
  if (!slug.value) return []
  const list = [slug.value, ...props.recentPrefixes.map(p => `${p}${slug.value}`)]
  return [...new Set(list)].filter(s => !branchProblem(s)).slice(0, 3)
})
watch(suggestions, () => (active.value = -1))

type Candidate = Pick<ProjectBranch, 'name' | 'current' | 'worktreePath'>
// Local branches, then remote ones the parent found with no local copy of the same name.
const candidates = computed<Candidate[]>(() => [
  ...props.branches,
  ...props.remoteBranches.map(name => ({ name, current: false, worktreePath: null })),
])
const isFree = (b: Candidate) => !b.current && !b.worktreePath
const hasFree = computed(() => candidates.value.some(isFree))
// With nothing typed, only branches that are not already a row above; typing finds any of them.
const matches = computed(() => {
  const q = filter.value.trim().toLowerCase()
  return candidates.value
    .filter(b => (q ? b.name.toLowerCase().includes(q) : isFree(b)))
    .slice(0, 6)
})
watch(matches, () => (branchActive.value = -1))
function branchHint(b: Candidate) {
  if (b.current) return 'this checkout'
  if (b.worktreePath) return `in ${folder(b.worktreePath)}`
  return 'new worktree'
}

function focusChip() {
  chip.value?.querySelector<HTMLElement>('button')?.focus()
}
function close(restoreFocus = true) {
  if (!open.value) return
  open.value = false
  active.value = -1
  filter.value = ''
  if (restoreFocus) void nextTick(focusChip)
}
async function toggle() {
  if (open.value) return close()
  open.value = true
  // the user asked for it, so focus may move in
  await nextTick()
  if (kind.value === 'new-worktree') input.value?.focus()
  else
    (
      pop.value?.querySelector<HTMLElement>('[data-rove][aria-pressed="true"]') ??
      pop.value?.querySelector<HTMLElement>('[data-rove]')
    )?.focus()
}
function chooseCheckout() {
  existing.value = null
  worktree.value = false
  branch.value = ''
  close()
}
function chooseNew() {
  existing.value = null
  worktree.value = true
  void nextTick(() => input.value?.focus())
}
function chooseExisting(next: ExistingWhere) {
  existing.value = next
  worktree.value = false
  branch.value = ''
  close()
}
function chooseBranch(b: Candidate) {
  // a branch that is already checked out somewhere is that place, not a second copy
  if (b.current) chooseCheckout()
  else if (b.worktreePath) chooseExisting({ kind: 'worktree', path: b.worktreePath })
  else chooseExisting({ kind: 'branch', branch: b.name })
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
function onFilterKey(e: KeyboardEvent) {
  const count = matches.value.length
  if (e.key === 'ArrowDown' && count) {
    e.preventDefault()
    branchActive.value = (branchActive.value + 1) % count
  } else if (e.key === 'ArrowUp' && count) {
    e.preventDefault()
    branchActive.value = branchActive.value <= 0 ? count - 1 : branchActive.value - 1
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const chosen = matches.value[branchActive.value] ?? matches.value[0]
    if (chosen) chooseBranch(chosen)
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    e.stopPropagation()
    close()
    return
  }
  // arrows step through the option rows (the text fields keep their own arrows)
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && open.value) {
    const rows = [...(pop.value?.querySelectorAll<HTMLElement>('[data-rove]') ?? [])]
    const at = rows.indexOf(e.target as HTMLElement)
    if (at < 0) return
    e.preventDefault()
    const next = e.key === 'ArrowDown' ? at + 1 : at - 1
    rows[(next + rows.length) % rows.length]?.focus()
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

function running(w: ProjectWorktree) {
  const n = w.sessions.filter(x => x.running).length
  return n ? `${n} running` : ''
}
function drift(w: ProjectWorktree) {
  const parts = []
  if (w.ahead) parts.push(`${w.ahead} ahead`)
  if (w.behind) parts.push(`${w.behind} behind`)
  return parts.join(', ')
}
function mainHint(w: ProjectWorktree) {
  return [w.dirty ? 'Uncommitted changes' : 'Clean', drift(w)].filter(Boolean).join(' · ')
}
</script>

<template>
  <div ref="root" class="composer-where" @keydown="onKeydown" @focusout="onFocusout">
    <span ref="chip" class="composer-where__chip">
      <IuButton
        variant="ghost"
        size="sm"
        :aria-label="`Where it runs: ${label}${dirty ? ', uncommitted changes' : ''}`"
        :title="chipTitle"
        aria-haspopup="dialog"
        :aria-expanded="open"
        :aria-controls="open ? `${id}-pop` : undefined"
        :disabled="disabled"
        @click="toggle"
      >
        <template v-if="!label.startsWith('⎇')" #icon
          ><IuIcon name="gitBranch" :size="14"
        /></template>
        {{ label }}
        <span v-if="dirty" class="composer-where__dirty" aria-hidden="true">•</span>
        <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
      </IuButton>
    </span>
    <div
      v-if="open"
      :id="`${id}-pop`"
      ref="pop"
      class="composer-where__pop"
      role="dialog"
      aria-label="Where it runs"
    >
      <button
        type="button"
        class="composer-where__option"
        data-where="checkout"
        data-rove
        :aria-pressed="kind === 'checkout'"
        @click="chooseCheckout"
      >
        <span class="composer-where__mark" aria-hidden="true">{{
          kind === 'checkout' ? '●' : '○'
        }}</span>
        <span class="composer-where__text">
          <span class="composer-where__title">
            {{ info ? `Main checkout · ⎇ ${mainName}` : 'This checkout' }}
            <template v-if="main?.dirty"
              ><span aria-hidden="true">•</span
              ><span class="sr-only"> uncommitted changes</span></template
            >
          </span>
          <span v-if="main" class="composer-where__hint">
            {{ mainHint(main) }}
            <span class="composer-where__path">{{ main.path }}</span>
          </span>
          <span v-else class="composer-where__hint">Work directly in the repository as it is</span>
        </span>
      </button>
      <template v-if="others.length">
        <p class="composer-where__heading">Existing worktrees</p>
        <button
          v-for="w in others"
          :key="w.path"
          type="button"
          class="composer-where__option"
          data-where="worktree"
          data-rove
          :title="w.path"
          :aria-pressed="chosenPath === w.path"
          @click="chooseExisting({ kind: 'worktree', path: w.path })"
        >
          <span class="composer-where__mark" aria-hidden="true">{{
            chosenPath === w.path ? '●' : '○'
          }}</span>
          <span class="composer-where__text">
            <span class="composer-where__title">
              {{ w.branch ? `⎇ ${w.branch}` : 'detached' }}
              <template v-if="w.dirty"
                ><span aria-hidden="true">•</span
                ><span class="sr-only"> uncommitted changes</span></template
              >
            </span>
            <span class="composer-where__hint composer-where__meta">
              <span class="composer-where__path">{{ folder(w.path) }}</span>
              <span v-if="running(w)">{{ running(w) }}</span>
              <IuBadge v-if="w.merged" size="xs" :intent="statusIntent.ok">merged</IuBadge>
            </span>
          </span>
        </button>
      </template>
      <div v-if="info || candidates.length" class="composer-where__branch">
        <label :for="`${id}-filter`" class="composer-where__label">Existing branch</label>
        <input
          :id="`${id}-filter`"
          v-model="filter"
          class="composer-where__input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="Filter branches"
          :aria-activedescendant="branchActive >= 0 ? `${id}-b${branchActive}` : undefined"
          @keydown="onFilterKey"
        />
        <ul class="composer-where__suggestions" aria-label="Branches">
          <li v-for="(b, i) in matches" :id="`${id}-b${i}`" :key="b.name">
            <button
              type="button"
              class="composer-where__suggestion composer-where__branch-row"
              :class="{ 'composer-where__suggestion--active': i === branchActive }"
              data-where="branch"
              tabindex="-1"
              :aria-pressed="chosenBranch === b.name"
              @click="chooseBranch(b)"
            >
              <span>{{ b.name }}</span>
              <span class="composer-where__hint">{{ branchHint(b) }}</span>
            </button>
          </li>
          <li v-if="!matches.length" class="composer-where__hint">
            {{ filter.trim() || hasFree ? 'No branch matches.' : 'No other branches' }}
          </li>
        </ul>
      </div>
      <button
        type="button"
        class="composer-where__option composer-where__option--new"
        data-where="new-worktree"
        data-rove
        :aria-pressed="kind === 'new-worktree'"
        @click="chooseNew"
      >
        <span class="composer-where__mark" aria-hidden="true">{{
          kind === 'new-worktree' ? '●' : '○'
        }}</span>
        <span class="composer-where__text">
          <span class="composer-where__title">New worktree</span>
          <span class="composer-where__hint">Work on a separate branch in its own folder</span>
        </span>
      </button>
      <div
        v-if="kind === 'new-worktree'"
        class="composer-where__branch composer-where__branch--plain"
      >
        <label :for="`${id}-branch`" class="composer-where__label">Branch name</label>
        <input
          :id="`${id}-branch`"
          ref="input"
          data-name
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
  top: 100%;
  left: 0;
  z-index: 30;
  margin-top: 6px;
  width: 340px;
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
.composer-where__heading {
  margin: 6px 8px 2px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
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
.composer-where__option--new {
  margin-top: 4px;
}
.composer-where__option:focus-visible,
.composer-where__suggestion:focus-visible,
.composer-where__input:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: calc(var(--iu-focus-offset) * -1);
}
.composer-where__mark {
  color: var(--iu-text-2);
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
.composer-where__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.composer-where__path {
  display: block;
  font-family: var(--iu-font-mono);
  overflow-wrap: anywhere;
}
.composer-where__meta .composer-where__path {
  display: inline;
}
.composer-where__dirty {
  margin-left: 2px;
}
.composer-where__branch {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 8px 4px;
  border-top: 1px solid var(--iu-border);
  margin-top: 4px;
}
.composer-where__branch--plain {
  border-top: 0;
  margin-top: 0;
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
.composer-where__branch-row {
  display: flex;
  flex-direction: column;
}
.composer-where__branch-row[aria-pressed='true'] {
  background: var(--iu-accent-wash);
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
