<script setup lang="ts">
// The side column: usage and context, metrics, the thread, tags, and a tabbed panel (files changed, plan, artifacts).
import { computed, ref } from 'vue'
import type { Session, SessionDetail } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuIcon } from '@/components/Icon'
import { IuField } from '@/components/Fields'
import { IuFilePath } from '@/components/FilePath'
import { IuMeter } from '@/components/Meter'
import { IuPropertyList, type PropertyItem } from '@/components/PropertyList'
import type { ActivityItem } from '@/components/ActivityStrip/ActivityStrip.vue'
import { IuStatusDot } from '@/components/StatusDot'
import { useToast } from '@/components/Toast'
import type { Status } from '@/styles/status'
import { contextWindow } from './sessionView'
import { fileChanges, latestPlan } from './workbench'
import { IuMarkdown } from '@/components/Markdown'
import SessionThreadPanel from './SessionThreadPanel.vue'

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
const todosDone = computed(() => props.session.todos.filter(t => t.status === 'completed').length)

// ── files ──
const files = computed(() => fileChanges(props.session.transcript))

// ── changes ──
const totals = computed(() => ({
  added: files.value.reduce((n, f) => n + f.added, 0),
  removed: files.value.reduce((n, f) => n + f.removed, 0),
}))

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
const fmt = (n: number) =>
  n >= 1_000_000
    ? `${+(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${+(n / 1000).toFixed(1)}k`
      : String(n)
const usage = computed<PropertyItem[]>(() => {
  const t = props.session.metrics.tokens
  return [
    { label: 'Input', value: fmt(t.input), mono: true },
    { label: 'Output', value: fmt(t.output), mono: true },
    { label: 'Cache read', value: fmt(t.cacheRead), mono: true },
    { label: 'Cache write', value: fmt(t.cacheWrite), mono: true },
    {
      label: 'Cost',
      value:
        props.session.metrics.costUsd === null
          ? '—'
          : `$${props.session.metrics.costUsd.toFixed(2)}`,
      mono: true,
    },
  ]
})
const ctxMax = computed(
  () => props.session.metrics.contextWindow ?? contextWindow(props.session.model),
)
const ctxUsed = computed(() => props.session.metrics.contextTokens)

// ── metrics ──
const duration = (ms: number | null) => {
  if (ms === null) return '—'
  const m = Math.round(ms / 60_000)
  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}
const metrics = computed<PropertyItem[]>(() => {
  const m = props.session.metrics
  const list: PropertyItem[] = [
    { label: 'Turns', value: String(m.turns), mono: true },
    { label: 'Tool calls', value: String(m.toolCalls), mono: true },
    { label: 'Active', value: duration(m.activeMs), mono: true },
    { label: 'Wall', value: duration(m.wallMs), mono: true },
  ]
  if (m.diff)
    list.push({
      label: 'Diff',
      value: `+${m.diff.added} −${m.diff.removed} · ${m.diff.files} files`,
      mono: true,
    })
  if (m.commits !== null) list.push({ label: 'Commits', value: String(m.commits), mono: true })
  return list
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
      </div>
      <div v-if="session.branch" class="session-side__row" aria-label="Branch">
        <IuIcon name="gitBranch" :size="14" />
        <span class="session-side__mono session-side__grow">{{ session.branch }}</span>
      </div>
      <div v-if="session.origin === 'external'" class="session-side__row">
        <IuIcon name="terminal" :size="14" />
        <span class="session-side__grow">From terminal</span>
      </div>
      <div v-if="session.parentId" class="session-side__row">
        <IuIcon name="link" :size="14" />
        <RouterLink class="session-side__link" :to="`/s/${session.parentId}`"
          >Forked from parent</RouterLink
        >
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
          {{ fmt(ctxUsed) }} / {{ fmt(ctxMax) }} tokens
        </p>
        <IuPropertyList :items="usage" density="compact" label-width="96px" />
        <IuPropertyList :items="metrics" density="compact" label-width="96px" />
      </div>
    </section>

    <details class="session-side__section" aria-labelledby="side-outputs">
      <summary id="side-outputs" class="session-side__summary">
        <span>Outputs</span>
        <IuIcon name="chevronRight" :size="14" class="session-side__caret" />
        <span class="session-side__summary-value">{{ session.artifacts.length }} outputs</span>
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
      <p
        v-if="files.length"
        class="session-side__totals"
        aria-label="Estimated lines changed in total"
      >
        <span class="session-side__added">+{{ totals.added }}</span>
        <span class="session-side__removed">−{{ totals.removed }}</span>
        <span class="session-side__sub"
          >in {{ files.length }} {{ files.length === 1 ? 'file' : 'files' }}</span
        >
      </p>
      <ul v-if="files.length" class="session-side__list">
        <li v-for="f in files" :key="f.path" class="session-side__file">
          <button type="button" class="session-side__open" @click="emit('openFile', f.path)">
            <IuFilePath class="session-side__path" :path="f.path" :root="session.cwd" />
          </button>
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

    <details class="session-side__section" aria-labelledby="side-plan">
      <summary id="side-plan" class="session-side__summary">
        <span>Plan</span>
        <IuIcon name="chevronRight" :size="14" class="session-side__caret" />
        <span class="session-side__summary-value">{{
          session.todos.length
            ? `${todosDone}/${session.todos.length} done`
            : plan
              ? 'Plan'
              : 'No plan'
        }}</span>
      </summary>
      <ul v-if="session.todos.length" class="session-side__list">
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
      <IuMarkdown v-else-if="plan" :source="plan" size="sm" />
      <p v-else class="session-side__none">No plan yet.</p>
    </details>

    <details class="session-side__section">
      <summary class="session-side__summary">
        <span>Thread</span>
        <IuIcon name="chevronRight" :size="14" class="session-side__caret" />
        <span class="session-side__summary-value">{{ session.branch ?? 'Session thread' }}</span>
      </summary>
      <SessionThreadPanel :session="session" />
    </details>

    <details class="session-side__section" aria-labelledby="side-tags">
      <summary id="side-tags" class="session-side__summary">
        <span>Tags</span>
        <IuIcon name="chevronRight" :size="14" class="session-side__caret" />
        <span class="session-side__summary-value">{{
          session.tags.length ? session.tags.join(', ') : 'No tags'
        }}</span>
      </summary>
      <div v-if="session.tags.length" class="session-side__tags">
        <IuBadge
          v-for="t in session.tags"
          :key="t"
          variant="tag"
          removable
          @remove="setTags(session.tags.filter(x => x !== t))"
          >{{ t }}</IuBadge
        >
      </div>
      <IuField
        v-model="newTag"
        label="Add a tag"
        hide-label
        placeholder="Add a tag ↵"
        size="sm"
        @keydown="addTag"
      />
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
  gap: 6px;
}
</style>
