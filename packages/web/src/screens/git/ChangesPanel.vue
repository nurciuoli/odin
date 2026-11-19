<script setup lang="ts">
// The Changes panel: staged and unstaged files, the selected file's diff with hunk and line staging, and a commit box.
// For a session it can also group the changes by the turn that made them (from checkpoints), commit a turn, or rewind
// the files to before one.
import { computed, nextTick, ref, shallowRef, toRef, watch } from 'vue'
import type { Checkpoint, CheckpointFileChange, SessionDetail } from '@odin/shared/api'
import type { GitAction, GitChange, GitFileDiff, GitTarget } from '@odin/shared/git'
import { SESSION_TRAILER, TURNS_TRAILER } from '@odin/shared/git'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuSegmented } from '@/components/Segmented'
import { useToast } from '@/components/Toast'
import DiffView from './DiffView.vue'
import { splitPath, STATE_LETTER, useGitStatus } from './useGit'

const props = defineProps<{ target: GitTarget; session?: SessionDetail | null }>()
const emit = defineEmits<{ open: [path: string] }>()
const api = useApi()
const { toast } = useToast()
const git = useGitStatus(toRef(props, 'target'))
const { status, busy } = git

const view = ref<'all' | 'turns'>('all')
const viewOptions = computed(() => [
  { value: 'all', label: 'All changes' },
  { value: 'turns', label: 'By turn', disabled: !props.session },
])

// ── selection and diff ───────────────────────────────────────────────────────
const selected = ref<{ path: string; staged: boolean } | null>(null)
const diff = shallowRef<GitFileDiff | null>(null)
let diffSeq = 0
async function loadDiff() {
  const sel = selected.value
  const id = ++diffSeq
  if (!sel) return void (diff.value = null)
  try {
    const d = await api.gitDiff(props.target, sel.path, sel.staged)
    if (id === diffSeq) diff.value = d
  } catch {
    if (id === diffSeq) diff.value = null
  }
}
watch(selected, () => void loadDiff())
// Keep the selection pointing at something that still exists after every status change.
watch(status, s => {
  if (!s) return
  const sel = selected.value
  const has = (staged: boolean, path: string) =>
    (staged ? s.staged : s.unstaged).some(c => c.path === path)
  if (sel && has(sel.staged, sel.path)) return void loadDiff()
  if (sel && has(!sel.staged, sel.path))
    return void (selected.value = { ...sel, staged: !sel.staged })
  const first = s.unstaged[0] ?? s.staged[0]
  selected.value = first ? { path: first.path, staged: !s.unstaged[0] } : null
})
const isSelected = (c: GitChange, staged: boolean) =>
  selected.value?.path === c.path && selected.value.staged === staged

const totals = computed(() => {
  const s = status.value
  if (!s) return { files: 0, add: 0, del: 0 }
  const all = [...s.staged, ...s.unstaged]
  return {
    files: git.changedCount.value,
    add: all.reduce((n, c) => n + (c.additions ?? 0), 0),
    del: all.reduce((n, c) => n + (c.deletions ?? 0), 0),
  }
})

// ── writes ───────────────────────────────────────────────────────────────────
const stagePaths = (paths: string[]) => git.run('Stage', t => api.gitStage(t, { paths }))
const unstagePaths = (paths: string[]) => git.run('Unstage', t => api.gitUnstage(t, { paths }))
async function discardPaths(paths: string[]) {
  const r = await git.run('Discard', t => api.gitDiscard(t, { paths }))
  if (!r.ok) return
  toast({
    title:
      paths.length === 1
        ? `Discarded ${splitPath(paths[0]!)[0]}`
        : `Discarded ${paths.length} files`,
    description: 'Kept in a stash, so you can bring it back.',
    intent: 'info',
    action: {
      label: 'Undo',
      onClick: () => void git.run('Undo discard', t => api.gitStashAction(t, 'pop', 'stash@{0}')),
    },
  })
}
function onHunk(action: 'stage' | 'unstage' | 'discard', hunkId: string, lines?: number[]) {
  const path = selected.value?.path
  if (!path) return
  const req = { hunks: [{ path, hunkId, lines }] }
  if (action === 'stage') void git.run('Stage', t => api.gitStage(t, req))
  else if (action === 'unstage') void git.run('Unstage', t => api.gitUnstage(t, req))
  else void git.run('Revert', t => api.gitDiscard(t, req))
}
async function stash() {
  const r = await git.run('Stash', t => api.gitStash(t, { includeUntracked: true }))
  if (r.ok) toast({ title: 'Changes stashed', intent: 'success', duration: 2500 })
}

// ── commit ───────────────────────────────────────────────────────────────────
const message = ref('')
const messageBox = ref<HTMLTextAreaElement>()
const turnCheckpoints = shallowRef<Checkpoint[]>([])
function draft(turns?: number[]) {
  const s = props.session
  if (!s) return
  const n = turns ?? turnCheckpoints.value.filter(c => c.files?.changed).map(c => c.turn)
  const range = n.length
    ? n.length === 1
      ? `${n[0]}`
      : `${Math.min(...n)}-${Math.max(...n)}`
    : null
  const subject = s.title.charAt(0).toLowerCase() + s.title.slice(1)
  message.value = [
    subject,
    '',
    `${SESSION_TRAILER}: ${s.id}`,
    ...(range ? [`${TURNS_TRAILER}: ${range}`] : []),
  ].join('\n')
}
const stagedCount = computed(() => status.value?.staged.length ?? 0)
type CommitOpts = { all?: boolean; amend?: boolean; skipActions?: boolean }
// A pre-commit git action that failed and stopped the last commit, with the options to try it again.
const blocked = ref<{ action: GitAction; opts: CommitOpts } | null>(null)
watch(
  () => `${props.target.kind}:${props.target.id}`,
  () => (blocked.value = null),
)
async function findBlocker(): Promise<GitAction | null> {
  try {
    const failed = (await api.gitActions(props.target)).filter(
      a => a.on === 'pre-commit' && a.blocking && a.lastRun && !a.lastRun.ok,
    )
    return failed.sort((a, b) => b.lastRun!.at.localeCompare(a.lastRun!.at))[0] ?? null
  } catch {
    return null
  }
}
async function commit(opts: CommitOpts = {}) {
  if (!message.value.trim() && !opts.amend) {
    messageBox.value?.focus()
    return
  }
  const r = await git.run('Commit', t => api.gitCommit(t, { message: message.value, ...opts }), {
    quiet: ['action-failed'],
  })
  if (!r.ok) {
    if (r.failure.code === 'action-failed') {
      const action = await findBlocker()
      if (action) blocked.value = { action, opts }
      else toast({ title: 'Commit failed', description: r.failure.message, intent: 'danger' })
    }
    return
  }
  blocked.value = null
  message.value = ''
  toast({ title: `Committed ${r.value.sha.slice(0, 7)}`, intent: 'success', duration: 2500 })
}
const blockedTail = computed(() => {
  const out = blocked.value?.action.lastRun?.output ?? ''
  return out.trimEnd().split('\n').slice(-14).join('\n')
})
const rerunning = ref(false)
async function rerun() {
  const b = blocked.value
  if (!b) return
  rerunning.value = true
  try {
    const run = await api.gitRunAction(props.target, b.action.id)
    if (run.ok) {
      blocked.value = null
      toast({ title: `${b.action.title} passes now`, description: 'Commit again when ready.' })
    } else blocked.value = { ...b, action: { ...b.action, lastRun: run } }
  } catch (e) {
    toast({ title: "Couldn't run it", description: String(e), intent: 'danger' })
  } finally {
    rerunning.value = false
  }
}
async function askToFix() {
  const b = blocked.value
  const s = props.session
  if (!b || !s) return
  const text = [
    `The git action "${b.action.title}" (${b.action.file}) failed, so my commit was blocked. Please fix what it reports, then stop.`,
    '',
    `Command: ${b.action.lastRun?.command.join(' ') ?? b.action.run.join(' ')}`,
    '',
    '```',
    blockedTail.value,
    '```',
  ].join('\n')
  try {
    await api.sendMessage(s.id, { text })
    toast({ title: 'Asked Claude to fix it', description: 'Run it again once the turn ends.' })
  } catch (e) {
    toast({ title: "Couldn't send the message", description: String(e), intent: 'danger' })
  }
}
const commitMenu: MenuItem[] = [
  { id: 'all', label: 'Stage everything and commit', icon: 'plus' },
  { id: 'amend', label: 'Amend the last commit', icon: 'pencil' },
]
function onCommitMenu(id: string) {
  void commit(id === 'all' ? { all: true } : { amend: true })
}
function onMessageKey(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    void commit()
  }
}

// ── by turn ──────────────────────────────────────────────────────────────────
const turnFiles = shallowRef(new Map<string, CheckpointFileChange[]>())
const rewinding = ref<string | null>(null)
async function loadTurns() {
  const s = props.session
  if (!s || view.value !== 'turns') return
  const list = (await api.listCheckpoints(s.id).catch(() => [] as Checkpoint[]))
    .filter(c => c.kind === 'turn')
    .slice(-20)
  turnCheckpoints.value = list
  const entries = await Promise.all(
    list.map(async c => {
      if (!c.files?.changed && !c.files?.added && !c.files?.removed)
        return [c.id, [] as CheckpointFileChange[]] as const
      const d = await api.checkpointDiff(s.id, c.id, 'turn').catch(() => null)
      return [c.id, d?.files ?? []] as const
    }),
  )
  turnFiles.value = new Map(entries)
}
watch([view, () => props.session?.id], () => void loadTurns(), { immediate: true })
watch(status, () => {
  if (view.value === 'turns') void loadTurns()
})
const turnText = (c: Checkpoint) => {
  const e = props.session?.transcript.find(x => x.id === c.messageId)
  return e && e.kind === 'user' ? e.text.split('\n')[0]!.slice(0, 120) : ''
}
const changedNow = computed(() => {
  const s = status.value
  return new Set(s ? [...s.staged, ...s.unstaged].map(c => c.path) : [])
})
const turnsNewestFirst = computed(() => [...turnCheckpoints.value].reverse())
const openIn = (path: string) => {
  const s = status.value
  if (!s) return
  const unstaged = s.unstaged.some(c => c.path === path)
  const staged = s.staged.some(c => c.path === path)
  if (unstaged || staged) selected.value = { path, staged: !unstaged }
}
async function commitTurn(c: Checkpoint) {
  const paths = (turnFiles.value.get(c.id) ?? [])
    .map(f => f.path)
    .filter(p => changedNow.value.has(p))
  if (!paths.length) return
  const r = await stagePaths(paths)
  if (!r.ok) return
  draft([c.turn])
  await nextTick()
  messageBox.value?.focus()
}
async function rewind(c: Checkpoint) {
  const s = props.session
  if (!s) return
  if (rewinding.value !== c.id) {
    rewinding.value = c.id
    setTimeout(() => {
      if (rewinding.value === c.id) rewinding.value = null
    }, 4000)
    return
  }
  rewinding.value = null
  try {
    await api.restoreCheckpoint(s.id, c.id, { files: true, conversation: false })
    toast({ title: `Files rewound to before turn ${c.turn}`, intent: 'success', duration: 3000 })
    void git.load()
  } catch (e) {
    toast({
      title: 'Rewind failed',
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  }
}
</script>

<template>
  <div class="git-changes">
    <div class="git-changes__bar">
      <IuSegmented v-if="session" v-model="view" :options="viewOptions" label="Group changes" />
      <span v-if="status?.repo" class="git-changes__sum">
        {{ totals.files }} {{ totals.files === 1 ? 'file' : 'files' }}
        <span class="git-changes__add">+{{ totals.add }}</span>
        <span class="git-changes__del">−{{ totals.del }}</span>
      </span>
      <span class="git-changes__grow" />
      <IuButton
        variant="ghost"
        size="sm"
        :disabled="!totals.files || !!busy"
        title="Stash all changes"
        @click="stash"
      >
        <template #icon><IuIcon name="database" :size="14" /></template>
        Stash
      </IuButton>
      <IuButton
        variant="ghost"
        size="sm"
        icon-only
        aria-label="Refresh"
        title="Refresh"
        @click="git.load()"
      >
        <template #icon><IuIcon name="retry" :size="14" /></template>
      </IuButton>
    </div>

    <p v-if="status && !status.repo" class="git-changes__empty">
      This folder isn't a git repository.
    </p>
    <div v-else class="git-changes__body">
      <div class="git-changes__list">
        <div class="git-changes__scroll">
          <template v-if="view === 'all'">
            <p v-if="status && !totals.files" class="git-changes__empty">
              No changes. The working tree matches the last commit.
            </p>
            <template v-for="group in ['staged', 'unstaged'] as const" :key="group">
              <section v-if="status && status[group].length" class="git-changes__group">
                <header class="git-changes__grouphead">
                  <span class="git-changes__cap">{{
                    group === 'staged' ? 'Staged' : 'Changes'
                  }}</span>
                  <span class="git-changes__count">{{ status[group].length }}</span>
                  <span class="git-changes__grow" />
                  <template v-if="group === 'staged'">
                    <IuButton
                      variant="ghost"
                      size="sm"
                      icon-only
                      aria-label="Unstage all"
                      title="Unstage all"
                      :disabled="!!busy"
                      @click="unstagePaths(status.staged.map(c => c.path))"
                    >
                      <template #icon><IuIcon name="minus" :size="14" /></template>
                    </IuButton>
                  </template>
                  <template v-else>
                    <IuButton
                      variant="ghost"
                      size="sm"
                      icon-only
                      aria-label="Discard all changes"
                      title="Discard all changes"
                      :disabled="!!busy"
                      @click="discardPaths(status.unstaged.map(c => c.path))"
                    >
                      <template #icon><IuIcon name="retry" :size="14" /></template>
                    </IuButton>
                    <IuButton
                      variant="ghost"
                      size="sm"
                      icon-only
                      aria-label="Stage all"
                      title="Stage all"
                      :disabled="!!busy"
                      @click="stagePaths(status.unstaged.map(c => c.path))"
                    >
                      <template #icon><IuIcon name="plus" :size="14" /></template>
                    </IuButton>
                  </template>
                </header>
                <ul class="git-changes__files">
                  <li
                    v-for="c in status[group]"
                    :key="c.path"
                    class="git-changes__file"
                    :class="{ 'git-changes__file--on': isSelected(c, group === 'staged') }"
                  >
                    <button
                      type="button"
                      class="git-changes__pick"
                      :aria-current="isSelected(c, group === 'staged') || undefined"
                      :title="c.path"
                      @click="selected = { path: c.path, staged: group === 'staged' }"
                    >
                      <span class="git-changes__state" :data-state="c.state">{{
                        STATE_LETTER[c.state]
                      }}</span>
                      <span class="git-changes__name">{{ splitPath(c.path)[0] }}</span>
                      <span class="git-changes__dir">{{ splitPath(c.path)[1] }}</span>
                      <span class="git-changes__grow" />
                      <span class="git-changes__stat">
                        <template v-if="c.additions !== null"
                          ><span class="git-changes__add">+{{ c.additions }}</span>
                          <span v-if="c.deletions" class="git-changes__del"
                            >−{{ c.deletions }}</span
                          ></template
                        >
                      </span>
                    </button>
                    <span class="git-changes__acts">
                      <IuButton
                        variant="ghost"
                        size="sm"
                        icon-only
                        :aria-label="`Open ${c.path}`"
                        title="Open file"
                        @click="emit('open', c.path)"
                      >
                        <template #icon><IuIcon name="file" :size="14" /></template>
                      </IuButton>
                      <IuButton
                        v-if="group === 'unstaged'"
                        variant="ghost"
                        size="sm"
                        icon-only
                        :aria-label="`Discard ${c.path}`"
                        title="Discard changes"
                        :disabled="!!busy"
                        @click="discardPaths([c.path])"
                      >
                        <template #icon><IuIcon name="retry" :size="14" /></template>
                      </IuButton>
                      <IuButton
                        variant="ghost"
                        size="sm"
                        icon-only
                        :aria-label="`${group === 'staged' ? 'Unstage' : 'Stage'} ${c.path}`"
                        :title="group === 'staged' ? 'Unstage' : 'Stage'"
                        :disabled="!!busy"
                        @click="group === 'staged' ? unstagePaths([c.path]) : stagePaths([c.path])"
                      >
                        <template #icon
                          ><IuIcon :name="group === 'staged' ? 'minus' : 'plus'" :size="14"
                        /></template>
                      </IuButton>
                    </span>
                  </li>
                </ul>
              </section>
            </template>
          </template>

          <template v-else>
            <p v-if="!turnCheckpoints.length" class="git-changes__empty">
              No turns with file changes yet.
            </p>
            <section
              v-for="c in turnsNewestFirst"
              :key="c.id"
              class="git-changes__turn"
              :aria-label="`Turn ${c.turn}`"
            >
              <header class="git-changes__turnhead">
                <span class="git-changes__tn">T{{ c.turn }}</span>
                <span class="git-changes__turnq">{{ turnText(c) || `Turn ${c.turn}` }}</span>
              </header>
              <p v-if="!(turnFiles.get(c.id) ?? []).length" class="git-changes__turnnone">
                No file changes
              </p>
              <ul v-else class="git-changes__files">
                <li
                  v-for="f in turnFiles.get(c.id)"
                  :key="f.path"
                  class="git-changes__file git-changes__file--turn"
                  :class="{ 'git-changes__file--on': selected?.path === f.path }"
                >
                  <button
                    type="button"
                    class="git-changes__pick"
                    :title="f.path"
                    @click="openIn(f.path)"
                  >
                    <span class="git-changes__state" :data-state="f.status">{{
                      f.status === 'added' ? 'A' : f.status === 'removed' ? 'D' : 'M'
                    }}</span>
                    <span class="git-changes__name">{{ splitPath(f.path)[0] }}</span>
                    <span class="git-changes__dir">{{ splitPath(f.path)[1] }}</span>
                    <span class="git-changes__grow" />
                    <span v-if="!changedNow.has(f.path)" class="git-changes__dir">committed</span>
                  </button>
                </li>
              </ul>
              <div v-if="(turnFiles.get(c.id) ?? []).length" class="git-changes__turnacts">
                <IuButton
                  size="sm"
                  :disabled="
                    !!busy || !(turnFiles.get(c.id) ?? []).some(f => changedNow.has(f.path))
                  "
                  @click="commitTurn(c)"
                >
                  <template #icon><IuIcon name="gitCommit" :size="14" /></template>
                  Commit turn
                </IuButton>
                <IuButton
                  :variant="rewinding === c.id ? 'danger' : 'ghost'"
                  size="sm"
                  :disabled="c.snapshot !== 'ok'"
                  :title="`Put every file back as it was before turn ${c.turn} (later turns too)`"
                  @click="rewind(c)"
                >
                  <template #icon><IuIcon name="history" :size="14" /></template>
                  {{ rewinding === c.id ? 'Rewind files, sure?' : 'Rewind to before' }}
                </IuButton>
              </div>
            </section>
          </template>
        </div>

        <form class="git-changes__commit" @submit.prevent="commit()">
          <section
            v-if="blocked"
            class="git-changes__blocked"
            role="alert"
            :aria-label="`${blocked.action.title} failed`"
          >
            <header class="git-changes__blocked-head">
              <IuIcon name="alert" :size="16" />
              <span class="git-changes__blocked-title"
                >{{ blocked.action.title }} failed. Nothing was committed.</span
              >
              <span class="git-changes__grow" />
              <IuButton
                size="sm"
                variant="ghost"
                icon-only
                aria-label="Dismiss"
                @click="blocked = null"
              >
                <template #icon><IuIcon name="close" :size="14" /></template>
              </IuButton>
            </header>
            <pre class="git-changes__blocked-out">{{ blockedTail }}</pre>
            <div class="git-changes__blocked-acts">
              <IuButton v-if="session" size="sm" variant="primary" @click="askToFix">
                <template #icon><IuIcon name="sparkle" :size="14" /></template>
                Ask Claude to fix
              </IuButton>
              <IuButton size="sm" variant="secondary" :loading="rerunning" @click="rerun">
                <template #icon><IuIcon name="retry" :size="14" /></template>
                Run again
              </IuButton>
              <span class="git-changes__grow" />
              <IuButton
                size="sm"
                variant="ghost"
                :disabled="!!busy"
                @click="commit({ ...blocked.opts, skipActions: true })"
                >Commit anyway</IuButton
              >
            </div>
          </section>
          <label class="git-changes__sr" for="git-commit-message">Commit message</label>
          <textarea
            id="git-commit-message"
            ref="messageBox"
            v-model="message"
            class="git-changes__message"
            rows="4"
            placeholder="Commit message"
            spellcheck="true"
            @keydown="onMessageKey"
          />
          <div class="git-changes__commitbar">
            <IuButton
              variant="primary"
              size="sm"
              type="submit"
              :disabled="!stagedCount || !!busy"
              :loading="busy === 'Commit'"
            >
              Commit {{ stagedCount }} {{ stagedCount === 1 ? 'file' : 'files' }}
              <kbd class="git-changes__kbd">⌘↵</kbd>
            </IuButton>
            <IuMenu :items="commitMenu" placement="top-start" @select="onCommitMenu">
              <template #trigger="{ toggle, open }">
                <IuButton
                  size="sm"
                  icon-only
                  aria-label="More commit options"
                  aria-haspopup="menu"
                  :aria-expanded="open"
                  @click="toggle"
                >
                  <template #icon><IuIcon name="chevronDown" :size="14" /></template>
                </IuButton>
              </template>
            </IuMenu>
            <span class="git-changes__grow" />
            <IuButton
              v-if="session"
              variant="ghost"
              size="sm"
              title="Draft from the session"
              @click="draft()"
            >
              <template #icon><IuIcon name="sparkle" :size="14" /></template>
              Draft
            </IuButton>
          </div>
        </form>
      </div>

      <div class="git-changes__diff">
        <header v-if="selected" class="git-changes__diffhead">
          <span class="git-changes__state">{{ selected.staged ? 'Staged' : 'Working tree' }}</span>
          <span class="git-changes__path"
            ><span class="git-changes__dir">{{ splitPath(selected.path)[1] }}/</span
            >{{ splitPath(selected.path)[0] }}</span
          >
        </header>
        <div class="git-changes__diffscroll">
          <DiffView
            :diff="diff"
            :mode="selected?.staged ? 'staged' : 'unstaged'"
            :busy="!!busy"
            @hunk="onHunk"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.git-changes {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: var(--iu-font-size-13);
}
.git-changes__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--iu-hairline);
  flex: none;
}
.git-changes__sum {
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
  white-space: nowrap;
}
.git-changes__add {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-positive);
}
.git-changes__del {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-danger);
}
.git-changes__grow {
  flex: 1;
  min-width: 0;
}
.git-changes__empty {
  margin: 0;
  padding: 16px 12px;
  color: var(--iu-text-muted);
}
.git-changes__body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(230px, 300px) 1fr;
}
@container (max-width: 760px) {
  .git-changes__body {
    grid-template-columns: 1fr;
    /* the list takes what it needs (its files scroll in a capped box), the diff the rest */
    grid-template-rows: auto minmax(200px, 1fr);
  }
  .git-changes__list {
    border-right: 0;
    border-bottom: 1px solid var(--iu-hairline);
  }
  .git-changes__scroll {
    max-height: 200px;
  }
  .git-changes__blocked-out {
    max-height: 120px;
  }
}
.git-changes__list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--iu-hairline);
}
.git-changes__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-bottom: 8px;
}
.git-changes__grouphead {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px 0 12px;
}
.git-changes__cap {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.git-changes__count {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  color: var(--iu-text-muted);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-pill);
  padding: 0 6px;
}
.git-changes__files {
  list-style: none;
  margin: 0;
  padding: 0;
}
.git-changes__file {
  position: relative;
  display: flex;
  align-items: center;
}
.git-changes__file:hover,
.git-changes__file:focus-within {
  background: var(--iu-hover);
}
.git-changes__file--on,
.git-changes__file--on:hover {
  background: var(--iu-surface);
}
.git-changes__file--on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--iu-accent);
}
.git-changes__pick {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 8px 0 14px;
  border: 0;
  background: none;
  color: var(--iu-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.git-changes__pick:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: -2px;
}
.git-changes__state {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-warning);
  flex: none;
}
.git-changes__state[data-state='added'],
.git-changes__state[data-state='untracked'] {
  color: var(--iu-positive);
}
.git-changes__state[data-state='untracked'] {
  color: var(--iu-info);
}
.git-changes__state[data-state='deleted'],
.git-changes__state[data-state='removed'],
.git-changes__state[data-state='conflicted'] {
  color: var(--iu-danger);
}
.git-changes__name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;
  min-width: 40px;
}
.git-changes__dir {
  color: var(--iu-text-disabled);
  font-size: var(--iu-font-size-12);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 0 1 auto;
  min-width: 0;
}
.git-changes__stat {
  display: inline-flex;
  gap: 4px;
  flex: none;
}
.git-changes__acts {
  display: none;
  gap: 0;
  padding-right: 6px;
}
.git-changes__file:hover .git-changes__acts,
.git-changes__file:focus-within .git-changes__acts {
  display: inline-flex;
}
.git-changes__file:hover .git-changes__stat,
.git-changes__file:focus-within .git-changes__stat {
  display: none;
}
.git-changes__turn {
  padding: 10px 0 12px;
  border-bottom: 1px solid var(--iu-hairline);
}
.git-changes__turnhead {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 12px 4px;
}
.git-changes__tn {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text-muted);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  padding: 0 5px;
  flex: none;
}
.git-changes__turnq {
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-12-5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-changes__turnnone {
  margin: 0;
  padding: 0 12px 0 44px;
  color: var(--iu-text-disabled);
  font-size: var(--iu-font-size-12);
}
.git-changes__file--turn .git-changes__pick {
  padding-left: 22px;
  height: 24px;
}
.git-changes__turnacts {
  display: flex;
  gap: 6px;
  padding: 6px 12px 0 22px;
}
.git-changes__commit {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-top: 1px solid var(--iu-hairline);
  background: var(--iu-surface-sunken);
}
.git-changes__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}
.git-changes__message {
  resize: vertical;
  min-height: 72px;
  padding: 8px 10px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  background: var(--iu-well);
  color: var(--iu-text);
  font: inherit;
  font-size: var(--iu-font-size-13);
  line-height: var(--iu-leading-snug);
}
.git-changes__message:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: 0;
}
.git-changes__commitbar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.git-changes__kbd {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  opacity: 0.8;
  margin-left: 4px;
}
.git-changes__diff {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.git-changes__diffhead {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid var(--iu-hairline);
  flex: none;
}
.git-changes__diffhead .git-changes__state {
  color: var(--iu-text-muted);
  font-weight: var(--iu-font-weight-regular);
}
.git-changes__path {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.git-changes__diffscroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.git-changes__blocked {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
  padding: 10px 12px;
  border: 1px solid var(--iu-danger-border);
  border-radius: var(--iu-radius-md);
  background: var(--iu-danger-wash);
}
.git-changes__blocked-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--iu-danger);
}
.git-changes__blocked-title {
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.git-changes__blocked-out {
  margin: 0;
  max-height: 180px;
  overflow: auto;
  padding: 8px 10px;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-well);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  line-height: var(--iu-leading-code);
  color: var(--iu-text-2);
  white-space: pre;
}
.git-changes__blocked-acts {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
</style>
