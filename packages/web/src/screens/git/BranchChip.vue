<script setup lang="ts">
// The session's branch in its header: name, commits ahead and behind, and a dot when the tree has changes. It opens a
// switcher: sync the current branch (Fetch, Pull, Push), switch to another one, open the session that already has a
// branch checked out in its worktree, or start a new branch. A dirty switch asks what to do with the changes, and a
// diverged pull or push asks how to bring the two sides together.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { SessionDetail } from '@odin/shared/api'
import type { GitBranch, GitTarget } from '@odin/shared/git'
import { registerShortcut } from '@/app/shortcuts'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { useToast } from '@/components/Toast'
import DirtySwitchDialog, { type DirtyChoice } from './DirtySwitchDialog.vue'
import SyncDialog from './SyncDialog.vue'
import { relativeTime, useGitStatus } from './useGit'

const props = defineProps<{ session: SessionDetail }>()
const emit = defineEmits<{
  /** "Commit first": open the Changes tab. */
  changes: []
}>()

const api = useApi()
const router = useRouter()
const { toast } = useToast()
const id = useId()
const target = computed<GitTarget>(() => ({ kind: 'session', id: props.session.id }))
const { status, busy, run, changedCount } = useGitStatus(target)

const shown = computed(() => !!status.value?.repo)
const branchLabel = computed(
  () => status.value?.branch ?? (status.value?.headSha?.slice(0, 7) || 'detached'),
)
const chipLabel = computed(() => {
  const s = status.value
  if (!s) return ''
  const parts = [`Branch ${branchLabel.value}`]
  if (s.ahead) parts.push(`${s.ahead} to push`)
  if (s.behind) parts.push(`${s.behind} to pull`)
  if (changedCount.value)
    parts.push(`${changedCount.value} changed ${changedCount.value === 1 ? 'file' : 'files'}`)
  return `${parts.join(', ')}. Switch or sync`
})

// ── popover ──
const open = ref(false)
const root = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const query = ref('')
const active = ref(0)
const branches = ref<GitBranch[]>([])
const loadingBranches = ref(false)

async function loadBranches() {
  loadingBranches.value = true
  try {
    branches.value = (await api.gitBranches(target.value)).branches
  } catch {
    branches.value = []
  } finally {
    loadingBranches.value = false
  }
}
// Fixed to the viewport: the header's title row clips anything that hangs out of it.
const popStyle = ref<Record<string, string>>({})
function place() {
  const r = root.value?.getBoundingClientRect()
  if (!r) return
  const width = Math.min(440, window.innerWidth - 32)
  const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16))
  popStyle.value = { top: `${r.bottom + 6}px`, left: `${left}px`, width: `${width}px` }
}
const onResize = () => close(false)
async function show() {
  place()
  open.value = true
  query.value = ''
  active.value = 0
  void loadBranches()
  await nextTick()
  input.value?.focus()
}
function close(refocus = true) {
  open.value = false
  if (refocus) void nextTick(() => root.value?.querySelector<HTMLElement>('button')?.focus())
}
const toggle = () => (open.value ? close() : void show())
function onPointerdown(e: PointerEvent) {
  if (open.value && !root.value?.contains(e.target as Node)) close(false)
}
watch(open, v => {
  if (v) {
    document.addEventListener('pointerdown', onPointerdown)
    window.addEventListener('resize', onResize)
  } else {
    document.removeEventListener('pointerdown', onPointerdown)
    window.removeEventListener('resize', onResize)
  }
})

const localNames = computed(() => new Set(branches.value.filter(b => !b.remote).map(b => b.name)))
const remoteShort = (name: string) => name.replace(/^[^/]+\//, '')
const matches = (b: GitBranch) => b.name.toLowerCase().includes(query.value.trim().toLowerCase())
const recent = computed(() =>
  branches.value
    .filter(b => !b.remote && !b.current && matches(b))
    .sort((a, b) => Date.parse(b.lastCommitAt) - Date.parse(a.lastCommitAt))
    .slice(0, 12),
)
const remoteOnly = computed(() =>
  branches.value
    .filter(
      b => b.remote && !b.name.endsWith('/HEAD') && !localNames.value.has(remoteShort(b.name)),
    )
    .filter(matches)
    .slice(0, 8),
)
const newName = computed(() => {
  const q = query.value.trim()
  if (!q || /\s/.test(q) || branches.value.some(b => b.name === q || remoteShort(b.name) === q))
    return null
  return q
})
type Row = { kind: 'branch'; branch: GitBranch } | { kind: 'new'; name: string }
const rows = computed<Row[]>(() => [
  ...recent.value.map(branch => ({ kind: 'branch' as const, branch })),
  ...remoteOnly.value.map(branch => ({ kind: 'branch' as const, branch })),
  ...(newName.value ? [{ kind: 'new' as const, name: newName.value }] : []),
])
watch(query, () => (active.value = 0))
const rowIndex = (r: Row) => rows.value.indexOf(r)
const rowFor = (b: GitBranch) => rows.value.find(r => r.kind === 'branch' && r.branch === b)!

function onKeydown(e: KeyboardEvent) {
  if (!open.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    close()
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const n = rows.value.length
    if (n) active.value = (active.value + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
  } else if (e.key === 'Enter' && e.target === input.value) {
    e.preventDefault()
    const row = rows.value[active.value]
    if (!row) return
    if (row.kind === 'new') void createBranch(row.name)
    else if (e.metaKey || e.ctrlKey) newSession(row.branch.name)
    else void choose(row.branch)
  }
}
function onFocusout(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (open.value && next && !root.value?.contains(next)) close(false)
}

// ── switching ──
const dirtyFor = ref<string | null>(null)
const dirtyOpen = ref(false)

function describe(r: { stashed: string | null; restored: boolean }): string | undefined {
  if (r.stashed && r.restored) return 'Your changes were stashed, and the ones left here came back.'
  if (r.stashed) return 'Your changes were stashed. They come back when you return.'
  if (r.restored) return 'The changes you left here came back.'
  return undefined
}
async function checkout(branch: string, opts: { create?: boolean; dirty?: 'stash' | 'carry' }) {
  const r = await run(
    opts.create ? 'New branch' : 'Switch branch',
    t => api.gitCheckout(t, { branch, create: opts.create, dirty: opts.dirty ?? 'fail' }),
    { quiet: ['dirty-tree'] },
  )
  if (r.ok) {
    toast({
      title: opts.create ? `Created ${r.value.branch}` : `Switched to ${r.value.branch}`,
      description: describe(r.value),
      intent: 'success',
    })
    return true
  }
  if (r.failure.code === 'dirty-tree') {
    dirtyFor.value = branch
    dirtyOpen.value = true
  }
  return false
}
async function choose(b: GitBranch) {
  if (b.worktreeSession) {
    close(false)
    void router.push({ name: 'session', params: { id: b.worktreeSession } })
    return
  }
  if (b.worktree) return
  close()
  await checkout(b.name, {})
}
async function createBranch(name: string) {
  close()
  // A new branch from HEAD keeps the changes where they are: nothing to ask.
  await checkout(name, { create: true, dirty: 'carry' })
}
function newSession(branch: string) {
  close(false)
  const local = branch.startsWith('origin/') ? remoteShort(branch) : branch
  void router.push({
    name: 'home',
    query: { project: props.session.project, branch: local, launch: '1' },
  })
}
async function onDirty(choice: DirtyChoice) {
  const branch = dirtyFor.value
  dirtyOpen.value = false
  if (!branch) return
  if (choice === 'commit') emit('changes')
  else if (choice === 'session') newSession(branch)
  else await checkout(branch, { dirty: choice })
}

// ── sync ──
const syncOpen = ref(false)
async function fetchNow() {
  const r = await run('Fetch', t => api.gitFetch(t))
  if (r.ok) toast({ title: r.value.message })
}
async function pull() {
  const r = await run('Pull', t => api.gitPull(t, { strategy: 'ff-only' }), {
    quiet: ['diverged'],
  })
  if (r.ok) toast({ title: r.value.message, intent: 'success' })
  else if (r.failure.code === 'diverged') openSync()
}
async function push() {
  const r = await run('Push', t => api.gitPush(t, {}), { quiet: ['diverged'] })
  if (r.ok) toast({ title: r.value.message, intent: 'success' })
  else if (r.failure.code === 'diverged') openSync()
}
function openSync() {
  close(false)
  syncOpen.value = true
}
async function onSync(req: { strategy: 'ff-only' | 'rebase' | 'merge'; push: boolean }) {
  syncOpen.value = false
  const pulled = await run('Pull', t => api.gitPull(t, { strategy: req.strategy }))
  if (!pulled.ok) return
  if (!req.push) {
    toast({ title: pulled.value.message, intent: 'success' })
    return
  }
  const pushed = await run('Push', t => api.gitPush(t, {}))
  if (pushed.ok)
    toast({
      title: `Synced ${branchLabel.value}`,
      description: `${pulled.value.message}, ${pushed.value.message.toLowerCase()}`,
      intent: 'success',
    })
}

const fetched = computed(() =>
  status.value?.fetchedAt ? `fetched ${relativeTime(status.value.fetchedAt)}` : 'never fetched',
)
const remoteLine = computed(() => {
  const s = status.value
  if (!s) return ''
  if (s.upstreamGone) return `${s.upstream} is gone`
  if (!s.upstream) return 'Not pushed yet'
  return `${s.upstream.split('/')[0]} · ${fetched.value}`
})
const diverged = computed(() => !!status.value?.ahead && !!status.value?.behind)

let withdraw: (() => void) | undefined
onMounted(() => {
  withdraw = registerShortcut({
    id: 'session-branch',
    keys: 'Mod+B',
    label: 'Switch or sync the branch',
    group: 'Session',
    run: () => {
      if (shown.value) void show()
    },
  })
})
onBeforeUnmount(() => {
  withdraw?.()
  document.removeEventListener('pointerdown', onPointerdown)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div
    v-if="shown && status"
    ref="root"
    class="branch-chip"
    @keydown="onKeydown"
    @focusout="onFocusout"
  >
    <IuButton
      variant="ghost"
      size="sm"
      class="branch-chip__button"
      :aria-label="chipLabel"
      aria-haspopup="dialog"
      :aria-expanded="open"
      :aria-controls="open ? `${id}-pop` : undefined"
      @click="toggle"
    >
      <template #icon><IuIcon name="gitBranch" :size="14" /></template>
      <span class="branch-chip__name">{{ branchLabel }}</span>
      <span v-if="status.ahead || status.behind" class="branch-chip__ab" aria-hidden="true">
        <span v-if="status.ahead" class="branch-chip__up">↑{{ status.ahead }}</span>
        <span v-if="status.behind" class="branch-chip__down">↓{{ status.behind }}</span>
      </span>
      <span v-if="changedCount" class="branch-chip__dirty" aria-hidden="true" />
    </IuButton>

    <div
      v-if="open"
      :id="`${id}-pop`"
      class="branch-chip__pop"
      :style="popStyle"
      role="dialog"
      aria-label="Switch or sync the branch"
    >
      <div class="branch-chip__search">
        <IuIcon name="search" :size="14" />
        <input
          ref="input"
          v-model="query"
          class="branch-chip__input"
          type="text"
          placeholder="Switch branch or type a new name…"
          aria-label="Switch branch or type a new name"
          role="combobox"
          aria-autocomplete="list"
          :aria-controls="`${id}-list`"
          aria-expanded="true"
          :aria-activedescendant="rows.length ? `${id}-row-${active}` : undefined"
          spellcheck="false"
          autocomplete="off"
        />
      </div>

      <div class="branch-chip__current">
        <div class="branch-chip__current-row">
          <IuIcon name="gitBranch" :size="14" />
          <span class="branch-chip__mono">{{ branchLabel }}</span>
          <span class="branch-chip__tag">this session</span>
          <span class="branch-chip__grow" />
          <span v-if="changedCount" class="branch-chip__changed">{{ changedCount }} changed</span>
        </div>
        <div class="branch-chip__current-row">
          <span class="branch-chip__muted">{{ remoteLine }}</span>
          <span class="branch-chip__grow" />
          <IuButton size="sm" variant="secondary" :disabled="!!busy" @click="fetchNow">
            <template #icon><IuIcon name="retry" :size="14" /></template>
            Fetch
          </IuButton>
          <IuButton
            v-if="diverged"
            size="sm"
            variant="secondary"
            :disabled="!!busy"
            @click="openSync"
          >
            <template #icon><IuIcon name="arrowDown" :size="14" /></template>
            Sync…
          </IuButton>
          <template v-else>
            <IuButton
              size="sm"
              variant="secondary"
              :disabled="!!busy || !status.upstream || !status.behind"
              @click="pull"
            >
              <template #icon><IuIcon name="arrowDown" :size="14" /></template>
              Pull<span v-if="status.behind" class="branch-chip__down">{{ status.behind }}</span>
            </IuButton>
            <IuButton
              size="sm"
              variant="secondary"
              :disabled="!!busy || !status.branch || (!!status.upstream && !status.ahead)"
              @click="push"
            >
              <template #icon><IuIcon name="arrowUp" :size="14" /></template>
              Push<span v-if="status.ahead" class="branch-chip__up">{{ status.ahead }}</span>
            </IuButton>
          </template>
        </div>
      </div>

      <div
        :id="`${id}-list`"
        class="branch-chip__list"
        role="listbox"
        aria-label="Branches"
        @mousedown.prevent
      >
        <p v-if="loadingBranches && !branches.length" class="branch-chip__note">
          Loading branches…
        </p>
        <template v-if="recent.length">
          <div class="branch-chip__group" role="presentation">Recent</div>
          <div
            v-for="b in recent"
            :id="`${id}-row-${rowIndex(rowFor(b))}`"
            :key="b.name"
            class="branch-chip__row"
            :class="{
              'branch-chip__row--active': rowIndex(rowFor(b)) === active,
              'branch-chip__row--off': !!b.worktree && !b.worktreeSession,
            }"
            role="option"
            :aria-selected="rowIndex(rowFor(b)) === active"
            :aria-disabled="!!b.worktree && !b.worktreeSession"
            @pointerenter="active = rowIndex(rowFor(b))"
            @click="choose(b)"
          >
            <IuIcon name="gitBranch" :size="14" />
            <span class="branch-chip__mono" :class="{ 'branch-chip__dim': b.upstreamGone }">{{
              b.name
            }}</span>
            <span class="branch-chip__meta">
              <template v-if="b.worktree">
                <span class="branch-chip__tag">worktree</span>
                <span v-if="b.worktreeSession">Open session</span>
                <span v-else>checked out elsewhere</span>
              </template>
              <span v-else-if="b.upstreamGone">upstream gone</span>
              <span v-else-if="b.ahead || b.behind" class="branch-chip__ab">
                <span v-if="b.ahead" class="branch-chip__up">↑{{ b.ahead }}</span>
                <span v-if="b.behind" class="branch-chip__down">↓{{ b.behind }}</span>
              </span>
              <span>{{ relativeTime(b.lastCommitAt) }}</span>
            </span>
          </div>
        </template>
        <template v-if="remoteOnly.length">
          <div class="branch-chip__group" role="presentation">Remote only</div>
          <div
            v-for="b in remoteOnly"
            :id="`${id}-row-${rowIndex(rowFor(b))}`"
            :key="b.name"
            class="branch-chip__row"
            :class="{ 'branch-chip__row--active': rowIndex(rowFor(b)) === active }"
            role="option"
            :aria-selected="rowIndex(rowFor(b)) === active"
            @pointerenter="active = rowIndex(rowFor(b))"
            @click="choose(b)"
          >
            <IuIcon name="external" :size="14" />
            <span class="branch-chip__mono">{{ b.name }}</span>
            <span class="branch-chip__meta"
              ><span>{{ relativeTime(b.lastCommitAt) }}</span></span
            >
          </div>
        </template>
        <div
          v-if="newName"
          :id="`${id}-row-${rows.length - 1}`"
          class="branch-chip__row branch-chip__row--new"
          :class="{ 'branch-chip__row--active': active === rows.length - 1 }"
          role="option"
          :aria-selected="active === rows.length - 1"
          @pointerenter="active = rows.length - 1"
          @click="createBranch(newName)"
        >
          <IuIcon name="plus" :size="14" />
          <span
            >New branch <span class="branch-chip__mono">{{ newName }}</span> from
            <span class="branch-chip__mono">{{ branchLabel }}</span></span
          >
        </div>
        <p v-if="!loadingBranches && !rows.length" class="branch-chip__note">
          {{
            query
              ? 'No branch matches. Type a name without spaces to create one.'
              : 'No other branches.'
          }}
        </p>
      </div>
      <div class="branch-chip__foot" aria-hidden="true">
        <span><kbd>↵</kbd> switch</span>
        <span><kbd>⌘↵</kbd> new session on branch</span>
      </div>
    </div>

    <DirtySwitchDialog
      v-if="dirtyOpen"
      v-model:open="dirtyOpen"
      :branch="dirtyFor ?? ''"
      :from="branchLabel"
      :status="status"
      @choose="onDirty"
    />
    <SyncDialog
      v-if="syncOpen"
      v-model:open="syncOpen"
      :target="target"
      :status="status"
      @sync="onSync"
    />
  </div>
</template>

<style>
.branch-chip {
  position: relative;
  display: inline-flex;
  flex: none;
}
.branch-chip__name {
  display: inline-block;
  max-width: 160px;
  vertical-align: bottom;
}
/* Narrow windows: the chip keeps its icon and counts; its accessible name still says the branch. */
@media (max-width: 1100px) {
  .branch-chip__name {
    max-width: 96px;
  }
}
.branch-chip__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.branch-chip__ab {
  display: inline-flex;
  gap: 4px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
}
.branch-chip__up {
  color: var(--iu-positive);
  font-family: var(--iu-font-mono);
  margin-left: 2px;
}
.branch-chip__down {
  color: var(--iu-info);
  font-family: var(--iu-font-mono);
  margin-left: 2px;
}
.branch-chip__dirty {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--iu-warning);
  flex: none;
}
.branch-chip__pop {
  position: fixed;
  z-index: 30;
  display: flex;
  flex-direction: column;
  background: var(--iu-raised);
  border: 1px solid var(--iu-border-strong);
  border-radius: var(--iu-radius-lg);
  box-shadow: var(--iu-shadow-popover);
  overflow: hidden;
  text-align: left;
  color: var(--iu-text);
}
.branch-chip__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 12px;
  border-bottom: 1px solid var(--iu-hairline);
  color: var(--iu-text-muted);
}
.branch-chip__input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
  outline: none;
}
.branch-chip__current {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--iu-hairline);
  font-size: var(--iu-font-size-13);
}
.branch-chip__current-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.branch-chip__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.branch-chip__dim {
  color: var(--iu-text-muted);
}
.branch-chip__tag {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10);
  line-height: var(--iu-leading-snug);
  padding: 0 4px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  color: var(--iu-text-muted);
}
.branch-chip__changed {
  font-size: var(--iu-font-size-12);
  color: var(--iu-warning);
}
.branch-chip__muted {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.branch-chip__grow {
  flex: 1;
}
.branch-chip__list {
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 6px 6px;
}
.branch-chip__group {
  padding: 8px 6px 4px;
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.branch-chip__row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 6px;
  border-radius: var(--iu-radius-md);
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
  cursor: pointer;
}
.branch-chip__row--active {
  background: var(--iu-hover);
  color: var(--iu-text);
}
.branch-chip__row--off {
  cursor: default;
  color: var(--iu-text-muted);
}
.branch-chip__row--new {
  margin-top: 4px;
  border-top: 1px solid var(--iu-hairline);
  border-radius: 0;
}
.branch-chip__meta {
  margin-left: auto;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.branch-chip__note {
  margin: 0;
  padding: 10px 6px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.branch-chip__foot {
  display: flex;
  gap: 14px;
  padding: 6px 12px;
  border-top: 1px solid var(--iu-hairline);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}
.branch-chip__foot kbd {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  padding: 0 4px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
}
</style>
