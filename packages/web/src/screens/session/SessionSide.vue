<script setup lang="ts">
// The Details column: where the session runs (repository, branch, pull request, quick links, tags), then usage and
// context, outputs, changes, background tasks and the plan. Each section's header carries a quiet one-glance reading.
import { computed, ref, watchEffect } from 'vue'
import type { Session, SessionDetail } from '@odin/shared/api'
import { useApi } from '@/api'
import { hasDesktop, openPath, type OpenTarget } from '@/app/desktop'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuFilePath } from '@/components/FilePath'
import { IuMeter } from '@/components/Meter'
import { IuSegmented } from '@/components/Segmented'
import FileHeatmap, { type HeatItem } from '@/screens/shared/FileHeatmap.vue'
import { IuPropertyList, type PropertyItem } from '@/components/PropertyList'
import type { ActivityItem } from '@/components/ActivityStrip/ActivityStrip.vue'
import { IuStatusDot } from '@/components/StatusDot'
import { useToast } from '@/components/Toast'
import type { Status } from '@/styles/status'
import { contextWindow } from './sessionView'
import { fileChanges, latestPlan, latestPlanFile } from './workbench'
import { IuMarkdown } from '@/components/Markdown'
import {
  TOKEN_LABEL,
  activeShare,
  cacheHitRate,
  changeSplit,
  duration,
  fmt,
  money,
  tokenMix,
} from './sideStats'

const props = withDefaults(defineProps<{ session: SessionDetail; tasks?: ActivityItem[] }>(), {
  tasks: () => [],
})
const emit = defineEmits<{
  updated: [session: Session]
  openFile: [path: string]
  openArtifact: [id: number, version: number]
  openTask: [id: string]
}>()

const api = useApi()
const { toast } = useToast()

// ── todos ──
const TODO_STATUS: Record<
  SessionDetail['todos'][number]['status'],
  { status: Status; label: string }
> = {
  pending: { status: 'queued', label: 'To do' },
  in_progress: { status: 'running', label: 'In progress' },
  completed: { status: 'ok', label: 'Done' },
}
const plan = computed(() => latestPlan(props.session.transcript))
const planFile = computed(() => latestPlanFile(props.session.transcript))
const planName = computed(() => planFile.value?.split(/[\\/]/).pop() ?? 'Latest plan')
const planOpen = ref(false)
function openPlan() {
  if (planFile.value) emit('openFile', planFile.value)
  else planOpen.value = !planOpen.value
}
const todosDone = computed(() => props.session.todos.filter(t => t.status === 'completed').length)
const todosPct = computed(() =>
  props.session.todos.length ? (todosDone.value / props.session.todos.length) * 100 : 0,
)

// ── files and changes ──
const files = computed(() => fileChanges(props.session.transcript))
const totals = computed(() => ({
  added: files.value.reduce((n, f) => n + f.added, 0),
  removed: files.value.reduce((n, f) => n + f.removed, 0),
}))
const split = computed(() => changeSplit(totals.value.added, totals.value.removed))
const changesView = ref('list')
const heatItems = computed<HeatItem[]>(() =>
  files.value.map(f => ({
    id: f.path,
    label: f.path.split('/').pop() ?? f.path,
    value: f.added + f.removed,
    title: `${f.path} · +${f.added} −${f.removed}`,
    note: [f.added ? `+${f.added}` : '', f.removed ? `−${f.removed}` : '']
      .filter(Boolean)
      .join(' '),
    added: f.added,
    removed: f.removed,
  })),
)
const mostChanged = computed(() => Math.max(1, ...files.value.map(f => f.added + f.removed)))

// ── disclosures: context details and finished tasks start closed ──
const contextOpen = ref(false)
const finishedOpen = ref(false)
const liveTasks = computed(() => props.tasks.filter(t => t.status === 'running'))
const doneTasks = computed(() => props.tasks.filter(t => t.status !== 'running'))
const ctxPct = computed(() =>
  ctxUsed.value === null || !(ctxMax.value > 0)
    ? null
    : Math.round((ctxUsed.value / ctxMax.value) * 100),
)

// ── usage ──
const ctxMax = computed(
  () => props.session.metrics.contextWindow ?? contextWindow(props.session.model),
)
const ctxUsed = computed(() => props.session.metrics.contextTokens)
const mix = computed(() => tokenMix(props.session.metrics.tokens))
const mixLabel = computed(
  () =>
    `Token mix: ${mix.value.map(m => `${TOKEN_LABEL[m.kind]} ${Math.round(m.pct)}%`).join(', ')}`,
)
const cacheHit = computed(() => cacheHitRate(props.session.metrics.tokens))
const costPerTurn = computed(() => {
  const { costUsd, turns } = props.session.metrics
  return costUsd !== null && turns > 0 ? `$${(costUsd / turns).toFixed(2)} / turn` : null
})
const activePct = computed(() =>
  activeShare(props.session.metrics.activeMs, props.session.metrics.wallMs),
)
const metrics = computed<PropertyItem[]>(() => {
  const m = props.session.metrics
  const list: PropertyItem[] = [
    { label: 'Turns', value: String(m.turns), mono: true },
    { label: 'Tool calls', value: String(m.toolCalls), mono: true },
    { label: 'Active', value: duration(m.activeMs), mono: true },
    { label: 'Wall', value: duration(m.wallMs), mono: true },
  ]
  if (m.commits !== null) list.push({ label: 'Commits', value: String(m.commits), mono: true })
  return list
})

// ── quick links ──
const desktop = hasDesktop()
const workspacePath = computed(() =>
  props.session.workspace.kind === 'worktree' ? props.session.workspace.path : props.session.cwd,
)
async function copy(what: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast({ title: `Copied ${what}`, intent: 'success' })
  } catch {
    toast({ title: `Couldn't copy ${what}`, intent: 'danger' })
  }
}
async function openIn(target: OpenTarget, what: string, path = workspacePath.value) {
  if (!(await openPath(path, target))) toast({ title: `Couldn't open ${what}`, intent: 'danger' })
}
// Each repository's folder and GitHub slug, for the copy and open icons beside it.
const projectInfo = ref<Record<string, { path: string; repo: string | null }>>({})
watchEffect(() => {
  for (const name of props.session.projects ?? [props.session.project]) {
    if (projectInfo.value[name]) continue
    api
      .getProject(name)
      .then(
        d => (projectInfo.value = { ...projectInfo.value, [name]: { path: d.path, repo: d.repo } }),
      )
      .catch(() => {})
  }
})
function folderPath(name: string): string | null {
  if (name === props.session.project) return workspacePath.value
  return projectInfo.value[name]?.path ?? null
}
const branchUrl = computed(() => {
  const repo = projectInfo.value[props.session.project]?.repo
  const b = props.session.branch
  return repo && b
    ? `https://github.com/${repo}/tree/${encodeURIComponent(b).replace(/%2F/g, '/')}`
    : null
})
const prState = computed(() => {
  const pr = props.session.pull
  return pr ? (pr.merged ? 'merged' : pr.state) : ''
})

// ── tags ──
const newTag = ref('')
async function setTags(tags: string[]) {
  try {
    emit('updated', await api.updateSession(props.session.id, { tags }))
  } catch (e) {
    toast({
      title: "Couldn't update tags",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  }
}
function addTag(e: KeyboardEvent) {
  if (e.key !== 'Enter') return
  e.preventDefault()
  const tag = newTag.value.trim()
  newTag.value = ''
  if (tag && !props.session.tags.includes(tag)) void setTags([...props.session.tags, tag])
}
</script>

<template>
  <div class="session-side">
    <div class="session-side__top">
      <div class="session-side__meta" aria-label="Session workspace">
        <div
          v-for="name in session.projects ?? [session.project]"
          :key="name"
          class="session-side__row"
        >
          <IuIcon name="folder" :size="14" />
          <RouterLink
            class="session-side__link"
            :to="`/p/${name}`"
            :title="name === session.project ? 'Working repository' : 'Additional repository'"
            >{{ name }}</RouterLink
          >
          <IuBadge
            v-if="name === session.project && session.workspace.kind === 'worktree'"
            variant="tag"
            size="xs"
            >worktree</IuBadge
          >
          <span class="session-side__grow" />
          <span v-if="folderPath(name)" class="session-side__acts">
            <IuButton
              variant="ghost"
              size="sm"
              icon-only
              :aria-label="`Copy path of ${name}`"
              :title="`Copy path: ${folderPath(name)}`"
              @click="copy('path', folderPath(name)!)"
            >
              <template #icon><IuIcon name="copy" :size="14" /></template>
            </IuButton>
            <IuButton
              v-if="desktop"
              variant="ghost"
              size="sm"
              icon-only
              :aria-label="`Show ${name} in files`"
              title="Show in file manager"
              @click="openIn('files', 'folder', folderPath(name)!)"
            >
              <template #icon><IuIcon name="external" :size="14" /></template>
            </IuButton>
          </span>
        </div>
        <div v-if="session.branch" class="session-side__row" aria-label="Branch">
          <IuIcon name="gitBranch" :size="14" />
          <span class="session-side__mono session-side__grow">{{ session.branch }}</span>
          <span class="session-side__acts">
            <IuButton
              variant="ghost"
              size="sm"
              icon-only
              aria-label="Copy branch name"
              :title="`Copy branch: ${session.branch}`"
              @click="copy('branch', session.branch)"
            >
              <template #icon><IuIcon name="copy" :size="14" /></template>
            </IuButton>
            <IuButton
              v-if="branchUrl"
              as="a"
              variant="ghost"
              size="sm"
              icon-only
              aria-label="Open branch on GitHub"
              title="Open on GitHub"
              :href="branchUrl"
              target="_blank"
              rel="noopener noreferrer"
            >
              <template #icon><IuIcon name="external" :size="14" /></template>
            </IuButton>
          </span>
        </div>
        <div v-if="session.pull" class="session-side__row" aria-label="Pull request">
          <IuIcon name="gitPullRequest" :size="14" />
          <a
            class="session-side__link"
            :href="session.pull.url"
            target="_blank"
            rel="noopener noreferrer"
            >PR #{{ session.pull.number }}</a
          >
          <IuBadge size="xs">{{ prState }}</IuBadge>
        </div>
        <div v-if="session.origin === 'external'" class="session-side__row">
          <IuIcon name="terminal" :size="14" />
          <span class="session-side__grow">From terminal</span>
        </div>
        <div v-if="plan" class="session-side__row" aria-label="Plan">
          <IuIcon name="file" :size="14" />
          <span>Plan</span>
          <button
            type="button"
            class="session-side__plan"
            :title="planFile ?? 'Show the plan'"
            :aria-expanded="planFile ? undefined : planOpen"
            @click="openPlan"
          >
            {{ planName }}
          </button>
        </div>
        <div v-if="plan && planOpen && !planFile" class="session-side__planbody">
          <IuMarkdown :source="plan" size="sm" />
        </div>
        <div v-if="session.parentId" class="session-side__row">
          <IuIcon name="link" :size="14" />
          <RouterLink class="session-side__link" :to="`/s/${session.parentId}`"
            >Forked from parent</RouterLink
          >
        </div>
      </div>

      <div class="session-side__tags" aria-label="Tags">
        <IuBadge
          v-for="t in session.tags"
          :key="t"
          variant="tag"
          removable
          @remove="setTags(session.tags.filter(x => x !== t))"
          >{{ t }}</IuBadge
        >
        <input
          v-model="newTag"
          class="session-side__tag-input"
          aria-label="Add a tag"
          placeholder="+ tag"
          size="6"
          @keydown="addTag"
        />
      </div>
    </div>

    <section class="session-side__section" aria-labelledby="side-context">
      <h2 id="side-context" class="session-side__title">
        <button
          type="button"
          class="session-side__toggle"
          :aria-expanded="contextOpen"
          aria-controls="side-context-body"
          @click="contextOpen = !contextOpen"
        >
          <span>Context</span>
          <IuIcon :name="contextOpen ? 'chevronDown' : 'chevronRight'" :size="14" />
          <span class="session-side__grow" />
          <span class="session-side__pct">{{ money(session.metrics.costUsd) }}</span>
          <span v-if="ctxPct !== null" class="session-side__pct">{{ ctxPct }}%</span>
        </button>
        <IuMeter
          v-if="ctxUsed !== null"
          class="session-side__ctx-meter"
          :value="ctxUsed"
          :max="ctxMax"
          aria-label="Context window used"
          :value-label="`${fmt(ctxUsed)} / ${fmt(ctxMax)}`"
          intent="auto"
          layout="inline"
        >
          <!-- the percentage beside the title says it; the warning glyph stays -->
          <template #value><span /></template>
        </IuMeter>
      </h2>
      <div v-show="contextOpen" id="side-context-body" class="session-side__detail">
        <p v-if="ctxUsed !== null" class="session-side__sub">
          {{ fmt(ctxUsed) }} / {{ fmt(ctxMax) }} tokens in the window
        </p>
        <div class="session-side__bar" role="img" :aria-label="mixLabel">
          <span
            v-for="m in mix"
            :key="m.kind"
            class="session-side__seg"
            :class="`session-side__seg--${m.kind}`"
            :style="{ width: `${m.pct}%` }"
          />
        </div>
        <dl class="session-side__kv">
          <div v-for="m in mix" :key="m.kind" class="session-side__kv-row">
            <dt>
              <span
                class="session-side__swatch"
                :class="`session-side__seg--${m.kind}`"
                aria-hidden="true"
              />{{ TOKEN_LABEL[m.kind] }}
            </dt>
            <dd class="session-side__mono">{{ fmt(m.value) }}</dd>
          </div>
          <div class="session-side__kv-row">
            <dt>Cache hit</dt>
            <dd class="session-side__mono">
              {{ cacheHit === null ? '—' : `${Math.round(cacheHit * 100)}%` }}
            </dd>
          </div>
          <div class="session-side__kv-row">
            <dt>Cost</dt>
            <dd class="session-side__mono">
              {{ money(session.metrics.costUsd) }}
              <span v-if="costPerTurn" class="session-side__sub">· {{ costPerTurn }}</span>
            </dd>
          </div>
        </dl>
        <IuPropertyList :items="metrics" density="compact" label-width="96px" />
        <div
          v-if="activePct !== null"
          class="session-side__bar session-side__bar--thin"
          role="img"
          :aria-label="`Active ${Math.round(activePct * 100)}% of wall time`"
        >
          <span
            class="session-side__seg session-side__seg--active"
            :style="{ width: `${activePct * 100}%` }"
          />
        </div>
      </div>
    </section>

    <details class="session-side__section" aria-labelledby="side-outputs">
      <summary id="side-outputs" class="session-side__summary">
        <span>Outputs</span>
        <IuIcon name="chevronRight" :size="14" class="session-side__caret" />
        <span class="session-side__summary-value"
          >{{ session.artifacts.length }}
          {{ session.artifacts.length === 1 ? 'output' : 'outputs' }}</span
        >
      </summary>
      <ul v-if="session.artifacts.length" class="session-side__list">
        <li v-for="a in session.artifacts" :key="a.id" class="session-side__file">
          <IuIcon name="file" :size="14" />
          <button
            type="button"
            class="session-side__open"
            @click="emit('openArtifact', a.id, a.latestVersion)"
          >
            {{ a.title }} · v{{ a.latestVersion }}
          </button>
        </li>
      </ul>
      <p v-else class="session-side__none">No outputs yet.</p>
    </details>

    <details class="session-side__section" aria-labelledby="side-changes">
      <summary id="side-changes" class="session-side__summary">
        <span>Changes</span>
        <IuIcon name="chevronRight" :size="14" class="session-side__caret" />
        <span class="session-side__summary-value"
          >{{ files.length }} files, +{{ totals.added }} -{{ totals.removed }}</span
        >
      </summary>
      <a
        v-if="session.pull"
        class="session-side__pr"
        :href="session.pull.url"
        target="_blank"
        rel="noopener noreferrer"
        >PR #{{ session.pull.number }} -
        {{ session.pull.merged ? 'merged' : session.pull.state }}</a
      >
      <div
        v-if="files.length"
        class="session-side__totals"
        aria-label="Estimated lines changed in total"
      >
        <span class="session-side__added">+{{ totals.added }}</span>
        <span class="session-side__removed">−{{ totals.removed }}</span>
        <span class="session-side__sub"
          >in {{ files.length }} {{ files.length === 1 ? 'file' : 'files' }}</span
        >
        <span
          v-if="split"
          class="session-side__bar session-side__bar--inline"
          role="img"
          :aria-label="`${Math.round(split.added)}% added, ${Math.round(split.removed)}% removed`"
        >
          <span
            class="session-side__seg session-side__seg--added"
            :style="{ width: `${split.added}%` }"
          />
          <span
            class="session-side__seg session-side__seg--removed"
            :style="{ width: `${split.removed}%` }"
          />
        </span>
      </div>
      <IuSegmented
        v-if="files.length"
        v-model="changesView"
        class="session-side__view"
        label="Changes view"
        :options="[
          { value: 'list', label: 'List' },
          { value: 'heatmap', label: 'Heatmap' },
        ]"
      />
      <FileHeatmap
        v-if="files.length && changesView === 'heatmap'"
        label="Changed files, sized by lines changed"
        :items="heatItems"
        @select="emit('openFile', $event)"
      />
      <ul v-else-if="files.length" class="session-side__list">
        <li v-for="f in files" :key="f.path" class="session-side__file">
          <button type="button" class="session-side__open" @click="emit('openFile', f.path)">
            <IuFilePath class="session-side__path" :path="f.path" :root="session.cwd" />
          </button>
          <span
            class="session-side__heat"
            aria-hidden="true"
            :style="{ width: `${Math.max(8, ((f.added + f.removed) / mostChanged) * 28)}px` }"
          />
          <span class="session-side__counts" aria-label="Estimated lines changed"
            ><span v-if="f.added" class="session-side__added">+{{ f.added }}</span
            ><span v-if="f.removed" class="session-side__removed">−{{ f.removed }}</span></span
          >
          <IuBadge v-if="f.failed" intent="warning" size="xs">failed</IuBadge>
          <span v-else-if="f.edits > 1" class="session-side__count">×{{ f.edits }}</span>
        </li>
      </ul>
      <p v-else class="session-side__none">No edits yet.</p>
    </details>

    <details class="session-side__section" aria-labelledby="side-tasks">
      <summary id="side-tasks" class="session-side__summary">
        <span>Background tasks</span>
        <IuIcon name="chevronRight" :size="14" class="session-side__caret" />
        <span class="session-side__summary-value"
          >{{ liveTasks.length }} running, {{ doneTasks.length }} finished</span
        >
      </summary>
      <ul v-if="liveTasks.length" class="session-side__list">
        <li v-for="t in liveTasks" :key="t.id" class="session-side__file">
          <IuStatusDot :status="t.status" :label="t.state" />
          <button type="button" class="session-side__open" @click="emit('openTask', t.id)">
            {{ t.label }}
          </button>
          <span v-if="t.time" class="session-side__count">{{ t.time }}</span>
        </li>
      </ul>
      <p v-if="!tasks.length" class="session-side__none">No background tasks.</p>
      <template v-if="doneTasks.length">
        <button
          type="button"
          class="session-side__toggle session-side__toggle--quiet"
          :aria-expanded="finishedOpen"
          aria-controls="side-tasks-done"
          @click="finishedOpen = !finishedOpen"
        >
          {{ doneTasks.length }} finished
          <IuIcon :name="finishedOpen ? 'chevronDown' : 'chevronRight'" :size="14" />
        </button>
        <ul v-show="finishedOpen" id="side-tasks-done" class="session-side__list">
          <li v-for="t in doneTasks" :key="t.id" class="session-side__file">
            <IuStatusDot :status="t.status" :label="t.state" />
            <button type="button" class="session-side__open" @click="emit('openTask', t.id)">
              {{ t.label }}
            </button>
            <span v-if="t.time" class="session-side__count">{{ t.time }}</span>
          </li>
        </ul>
      </template>
    </details>

    <details v-if="session.todos.length" class="session-side__section" aria-labelledby="side-todos">
      <summary id="side-todos" class="session-side__summary">
        <span>To-dos</span>
        <IuIcon name="chevronRight" :size="14" class="session-side__caret" />
        <span class="session-side__summary-value"
          >{{ todosDone }}/{{ session.todos.length }} done</span
        >
      </summary>
      <div
        class="session-side__bar session-side__bar--thin"
        role="img"
        :aria-label="`${todosDone} of ${session.todos.length} steps done`"
      >
        <span
          class="session-side__seg session-side__seg--done"
          :style="{ width: `${todosPct}%` }"
        />
      </div>
      <ul class="session-side__list">
        <li v-for="(t, i) in session.todos" :key="i" class="session-side__todo">
          <IuStatusDot
            :status="TODO_STATUS[t.status].status"
            :label="TODO_STATUS[t.status].label"
          />
          <span :class="{ 'session-side__done': t.status === 'completed' }">{{
            t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content
          }}</span>
        </li>
      </ul>
    </details>
  </div>
</template>

<style>
.session-side__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: var(--iu-text);
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  list-style: none;
}
.session-side__caret {
  flex: none;
  color: var(--iu-text-muted);
}
details[open] > .session-side__summary .session-side__caret {
  transform: rotate(90deg);
}
.session-side__summary::-webkit-details-marker {
  display: none;
}
.session-side__summary:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.session-side__summary-value {
  margin-left: auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--iu-text-muted);
}
.session-side {
  display: flex;
  flex-direction: column;
}
/* Every block is a quiet band: same padding, a hairline between, no boxes. */
.session-side > * {
  padding: 14px 0;
  border-top: 1px solid var(--iu-border-quiet);
}
.session-side > :first-child {
  padding-top: 0;
  border-top: 0;
}
.session-side > :last-child {
  padding-bottom: 0;
}
.session-side__top {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.session-side__meta {
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
}
.session-side__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.session-side__row > .iu-icon {
  flex: none;
  color: var(--iu-text-muted);
}
.session-side__grow {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.session-side__acts {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0;
}
.session-side__plan {
  min-width: 0;
  margin-left: auto;
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  font-family: var(--iu-font-mono);
  color: var(--iu-text-2);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-side__plan:hover {
  color: var(--iu-text);
}
.session-side__plan:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.session-side__planbody {
  max-height: 240px;
  overflow: auto;
}
.session-side__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.session-side__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text);
}
.session-side__toggle {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.session-side__toggle--quiet {
  flex: none;
  align-self: flex-start;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.session-side__toggle:hover {
  color: var(--iu-text);
}
.session-side__toggle:focus-visible,
.session-side__open:focus-visible,
.session-side__pr:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
  border-radius: var(--iu-radius-sm);
}
.session-side__pct {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.session-side__ctx-meter {
  flex: none;
  width: 48px;
}
.session-side__detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.session-side__sub {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
/* Quiet bars: a hairline-thin proportion strip that backs up the numbers beside it, never replaces them. */
.session-side__bar {
  display: flex;
  height: 4px;
  overflow: hidden;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-border-quiet);
}
.session-side__bar--thin {
  height: 3px;
}
.session-side__bar--inline {
  flex: 1;
  min-width: 24px;
  align-self: center;
}
.session-side__seg {
  flex: none;
  height: 100%;
}
.session-side__seg--input {
  background: var(--iu-text-muted);
}
.session-side__seg--output {
  background: var(--iu-accent);
}
.session-side__seg--cacheRead {
  background: var(--iu-positive);
}
.session-side__seg--cacheWrite {
  background: var(--iu-border-strong);
}
.session-side__seg--active,
.session-side__seg--done {
  background: var(--iu-positive);
}
.session-side__seg--added {
  background: var(--iu-positive);
}
.session-side__seg--removed {
  background: var(--iu-danger);
}
.session-side__kv {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  font-size: var(--iu-font-size-13);
}
.session-side__kv-row {
  display: grid;
  grid-template-columns: 96px 1fr;
  align-items: baseline;
}
.session-side__kv dt {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--iu-text-muted);
}
.session-side__kv dd {
  margin: 0;
  color: var(--iu-text);
}
.session-side__swatch {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}
.session-side__totals {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.session-side__pr {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-12);
  text-decoration: none;
}
.session-side__pr:hover {
  color: var(--iu-text);
}
.session-side__link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--iu-text);
  text-decoration: none;
}
.session-side__link:hover {
  text-decoration: underline;
  text-decoration-color: var(--iu-border);
  text-underline-offset: 3px;
}
.session-side__link:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
  border-radius: var(--iu-radius-sm);
}
.session-side__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.session-side__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.session-side__todo {
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-size: var(--iu-font-size-13);
  line-height: var(--iu-leading-normal);
  color: var(--iu-text);
}
.session-side__done {
  color: var(--iu-text-muted);
  text-decoration: line-through;
}
.session-side__file {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: var(--iu-font-size-13);
}
.session-side__file > .iu-icon {
  flex: none;
  color: var(--iu-text-muted);
}
.session-side__open {
  min-width: 0;
  flex: 1;
  border: 0;
  padding: 0;
  background: transparent;
  color: var(--iu-text);
  text-align: left;
  cursor: pointer;
  font: inherit;
  overflow-wrap: anywhere;
}
/* a per-file sliver sized against the busiest file */
.session-side__view {
  margin: 4px 0;
}
.session-side__heat {
  flex: none;
  height: 3px;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-border-strong);
}
.session-side__counts {
  flex: none;
  display: inline-flex;
  gap: 6px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.session-side__added {
  color: var(--iu-positive);
}
.session-side__removed {
  color: var(--iu-danger);
}
.session-side__path {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.session-side__count {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.session-side__none {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.session-side__tags {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.session-side__tag-input {
  width: 6ch;
  min-width: 0;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: none;
  font: inherit;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.session-side__tag-input::placeholder {
  color: var(--iu-text-muted);
}
.session-side__tag-input:hover,
.session-side__tag-input:focus {
  background: var(--iu-surface-sunken);
}
.session-side__tag-input:focus {
  width: 14ch;
  outline: 1px solid var(--iu-border);
  color: var(--iu-text);
}
.session-side__tag-input:focus-visible {
  outline: 2px solid var(--iu-accent);
}
</style>
