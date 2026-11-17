<script setup lang="ts">
// /s/:id — one conversation. The record and transcript come from getSession; live frames fold in through
// useSessionView. Nothing that appears on its own takes focus; a polite live region says when Claude needs an answer
// or finishes a turn.
//
// Details holds the plan, changes, artifacts and metrics. The outer column previews files or the selected artifact.
// Narrow windows use overlays; explicit artifact drawer dismissal returns focus to its opener.
// Side threads (questions asked beside this session) show in the preview pane's Side view. One just asked is
// selected there without taking focus; where the pane would cover the conversation (narrow, or squeezing the details
// panel) a toast offers to open it instead.
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  toRef,
  useTemplateRef,
  watch,
} from 'vue'
import { taskKey } from '@odin/shared/harness'
import TaskPreview from './TaskPreview.vue'
import {
  activityTasks,
  visibleActivity,
  taskStatus,
  taskStateLabel,
  taskTime,
  activityLabel,
} from './activity'
import { useRoute, useRouter } from 'vue-router'
import type { ModelInfo, Session, PermissionAnswerScope, PermissionMode } from '@odin/shared/api'
import { useApi } from '@/api'
import { useToast } from '@/components/Toast'
import { registerCommand } from '@/app/commands'
import { markSeen } from '@/app/seen'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuIcon } from '@/components/Icon'
import { IuSidePanel } from '@/components/SidePanel'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import ArtifactPanel from './ArtifactPanel.vue'
import SessionComposer from './SessionComposer.vue'
import NativeControls from '@/screens/shared/NativeControls.vue'
import SessionMessageQueue from './SessionMessageQueue.vue'
import SessionHeader from './SessionHeader.vue'
import SessionPrompts from './SessionPrompts.vue'
import SessionSide from './SessionSide.vue'
import SessionThread from './SessionThread.vue'
import SessionWorkbench from './SessionWorkbench.vue'
import SideThreadPane from './SideThreadPane.vue'
import { useSideThreads } from './SideThreads'
import type { PreviewView } from './workbench'
import { buildRows, contextWindow } from './sessionView'

import { useMediaQuery } from './useMediaQuery'
import { useSessionView } from './useSessionView'

const props = defineProps<{ id: string }>()

const api = useApi()
const router = useRouter()
const route = useRoute()
const { view, phase, error, load, setRecord, setQueue } = useSessionView(toRef(props, 'id'))
const { toast } = useToast()
const side = useSideThreads(toRef(props, 'id'))
const sideThreads = side.threads

const session = computed(() => view.value?.detail ?? null)
// Opening a session reads it: Home stops listing it as finished-but-unopened (`app/seen.ts`). Updates that land while
// it is open count as read too.
watch(
  () => [session.value?.id, session.value?.updatedAt] as const,
  ([id, updatedAt]) => {
    if (id && updatedAt) markSeen({ id, updatedAt })
  },
  { immediate: true },
)
const parentEntryIds = computed(() => new Set(session.value?.transcript.map(e => e.id) ?? []))
// The record's last failure, unless the thread already says it (a turn that failed while this page was open).
const recordError = computed(() => {
  const error = session.value?.error
  if (!error) return null
  const shown = session.value!.transcript.some(e => e.kind === 'system' && e.text.includes(error))
  return shown ? null : error
})
const now = ref(Date.now())
const clock = setInterval(() => {
  now.value = Date.now()
}, 1000)
onBeforeUnmount(() => clearInterval(clock))
const dismissedTasks = ref(new Set<string>())
const selectedTask = ref<string | null>(null)
const taskPreview = useTemplateRef<InstanceType<typeof TaskPreview>>('taskPreview')
const tasks = computed(() => activityTasks(session.value?.transcript ?? []))
const activity = computed(() =>
  visibleActivity(tasks.value, now.value, dismissedTasks.value, selectedTask.value),
)
const activityItems = computed(() =>
  activity.value.map(task => ({
    id: taskKey(task),
    label: activityLabel(task),
    kind: task.kind === 'agent' ? 'Agent' : 'Command',
    status: taskStatus(task.state),
    state: taskStateLabel(task),
    time: taskTime(task, now.value),
    summary: task.summary,
    dismissible: task.state !== 'running',
  })),
)
// Background work lives in the details panel; while that is closed the header shows a quiet count of what runs.
const runningCount = computed(() => activityItems.value.filter(t => t.status === 'running').length)
const previewTask = computed(() => tasks.value.find(t => taskKey(t) === selectedTask.value) ?? null)
let taskOpener: HTMLElement | null = null
async function openTask(id: string) {
  taskOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  selectedTask.value = id
  previewDismissed.value = false
  workbenchTab.value = 'activity'
  if (narrow.value || compact.value) setSide(false)
  if (narrow.value) {
    await nextTick()
    taskPreview.value?.focus()
  }
}
async function closeTask() {
  selectedTask.value = null
  workbenchTab.value = filesOpen.value ? 'files' : 'artifacts'
  await nextTick()
  if (taskOpener?.isConnected) taskOpener.focus()
  taskOpener = null
}
watch(
  () => props.id,
  () => {
    selectedTask.value = null
    dismissedTasks.value = new Set()
    previewDismissed.value = false
    asideOpen.value = false
    selectedSide.value = null
  },
)
let activitySession: string | null = null
watch(
  () => tasks.value.map(t => [taskKey(t), t.state] as const),
  (states, previous) => {
    const initial = activitySession !== session.value?.id
    activitySession = session.value?.id ?? null
    const before = new Map(previous)
    for (const [id, state] of states) {
      if (
        !initial &&
        (before.has(id)
          ? before.get(id) !== state
          : ['completed', 'failed', 'stopped'].includes(state))
      ) {
        const task = tasks.value.find(t => taskKey(t) === id)!
        announcement.value = `${task.label}: ${taskStateLabel(task)}`
      }
    }
  },
)

const rows = computed(() => {
  const v = view.value
  if (!v) return []
  return buildRows(v.detail.transcript, {
    pending: v.detail.pending,
    streaming: v.streaming,
    running: v.detail.live && (v.detail.state === 'running' || v.detail.state === 'waiting'),
    artifacts: v.detail.artifacts,
  })
})
const working = computed(
  () => session.value?.state === 'running' && (view.value?.streaming.length ?? 0) === 0,
)
const context = computed(() => {
  const s = session.value
  if (!s || s.metrics.contextTokens === null) return undefined
  return { used: s.metrics.contextTokens, max: s.metrics.contextWindow ?? contextWindow(s.model) }
})

// ── models, for the live picker ──
const models = ref<ModelInfo[]>([])
const permissionModes = ref<PermissionMode[]>([])
const permissionScopes = ref<Exclude<PermissionAnswerScope, 'once'>[]>([])
watch(
  () => session.value?.harness,
  async harness => {
    if (!harness) return
    permissionScopes.value = []
    permissionModes.value = []
    void api
      .getSettings()
      .then(settings => {
        if (session.value?.harness !== harness) return
        permissionModes.value = settings.harnesses.find(h => h.id === harness)?.capabilities
          ?.permissionModes ?? [
          'default',
          'acceptEdits',
          'plan',
          'auto',
          'dontAsk',
          'bypassPermissions',
        ]
        const scopes = settings.harnesses.find(h => h.id === harness)?.capabilities
          ?.permissionScopes ?? ['once', 'session', 'project', 'local', 'user']
        permissionScopes.value = scopes.filter(
          (scope): scope is Exclude<PermissionAnswerScope, 'once'> => scope !== 'once',
        )
      })
      .catch(() => {})
    try {
      const next = await api.listModels(harness)
      if (session.value?.harness === harness) models.value = next
    } catch {
      // the picker just shows the current model
    }
  },
  { immediate: true },
)

// ── announcements ──
const announcement = ref('')
watch(
  () => session.value?.pending.map(p => p.id) ?? [],
  (ids, before) => {
    if (ids.some(id => !before?.includes(id)))
      announcement.value =
        ids.length > 1 ? `Needs your answer, ${ids.length} waiting` : 'Needs your answer'
  },
)
watch(
  () => view.value?.lastTurn,
  turn => {
    if (turn) announcement.value = turn.ok ? 'The agent finished the turn' : 'The turn ended early'
  },
)

// ── side panel ──
// Details follows the window until the user decides: with room to spare it opens on its own, and it steps aside
// when the preview pane would squeeze the conversation. The header's toggle (or the panel's own close) is a
// decision, and it is remembered.
const DETAILS_KEY = 'odin.session.details'
function readDetails(): boolean | null {
  try {
    const v = window.localStorage.getItem(DETAILS_KEY)
    return v === 'open' ? true : v === 'closed' ? false : null
  } catch {
    return null
  }
}
let chosen = readDetails()
const roomy = useMediaQuery('(min-width: 1280px)')
const sideOpen = ref(chosen ?? false)
let automatic = false
/** Open or close the panel for the layout's sake: not a choice, so it is not remembered. */
function setSide(open: boolean) {
  if (open === sideOpen.value) return
  automatic = true
  sideOpen.value = open
}
watch(sideOpen, open => {
  if (automatic) {
    automatic = false
    return
  }
  chosen = open
  try {
    window.localStorage.setItem(DETAILS_KEY, open ? 'open' : 'closed')
  } catch {
    // private mode or storage off: the choice lasts for this page only
  }
})

// ── artifact column ──
const artifacts = computed(() => view.value?.detail.artifacts ?? [])
// below this width the column would squeeze the conversation: it becomes a drawer
const compact = useMediaQuery('(max-width: 1600px)')
const narrow = useMediaQuery('(max-width: 1024px)')
const drawerOpen = ref(false)
const artifactPanel = useTemplateRef<InstanceType<typeof ArtifactPanel>>('artifactPanel')
const shownArtifact = ref<{ id: number; version: number } | null>(null)
let opener: HTMLElement | null = null

async function openDrawer() {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  drawerOpen.value = true
  await nextTick()
  // the user asked for it: focus goes into the drawer
  await artifactPanel.value?.focus()
}
function onDrawerClosed() {
  const back = opener
  opener = null
  if (back?.isConnected) back.focus()
}
// ── content preview ──
const workbench = ref<InstanceType<typeof SessionWorkbench>>()
function openFile(path: string) {
  previewDismissed.value = false
  filesOpen.value = true
  workbenchTab.value = 'files'
  workbench.value?.openFile(path)
  if (narrow.value || compact.value) setSide(false)
}
function toggleFiles() {
  previewDismissed.value = false
  filesOpen.value = true
  workbenchTab.value = 'files'
}
const filesOpen = ref(false)
const previewDismissed = ref(false)
const previewWidth = ref(760)
const artifactPreviewWidth = computed(() => Math.max(480, previewWidth.value - 4))
const previewAvailable = computed(
  () =>
    !!session.value &&
    (selectedTask.value !== null ||
      filesOpen.value ||
      asideOpen.value ||
      (!narrow.value && artifacts.value.length > 0)),
)
const showWorkbench = computed(() => previewAvailable.value && !previewDismissed.value)
watch(
  () => roomy.value && !(showWorkbench.value && compact.value) && !narrow.value,
  fits => {
    if (chosen === null) setSide(fits)
  },
  { immediate: true },
)
const workbenchTab = ref<PreviewView | null>(null)
const tab = computed<PreviewView>({
  get: () => workbenchTab.value ?? (artifacts.value.length ? 'artifacts' : 'files'),
  set: t => (workbenchTab.value = t),
})
// a new artifact brings its tab forward (selection only; focus stays where it is)
watch(
  () => artifacts.value.length,
  (n, before) => {
    if (before !== undefined && n > before && selectedTask.value === null)
      workbenchTab.value = 'artifacts'
  },
)

// A card in the thread: select its tab; on a narrow window, open the drawer on it.
function openArtifact(id: number, version: number) {
  previewDismissed.value = false
  if (narrow.value || compact.value) setSide(false)
  if (!narrow.value) workbenchTab.value = 'artifacts'
  artifactPanel.value?.show(id, version)
  if (narrow.value && !drawerOpen.value) void openDrawer()
}
watch(
  () => [session.value?.id, route.query.artifact, artifacts.value] as const,
  async ([, raw]) => {
    const id = Number(Array.isArray(raw) ? raw[0] : raw)
    const artifact = artifacts.value.find(a => a.id === id)
    if (!artifact) return
    await nextTick()
    // A deep link selects the preview without moving focus.
    previewDismissed.value = false
    workbenchTab.value = 'artifacts'
    artifactPanel.value?.show(id, artifact.latestVersion)
    if (narrow.value) drawerOpen.value = true
  },
  { immediate: true },
)
const previewToggle = useTemplateRef<{ $el: HTMLElement }>('previewToggle')
async function closePreview() {
  previewDismissed.value = true
  await nextTick()
  previewToggle.value?.$el.focus()
}
function togglePreview() {
  if (showWorkbench.value) void closePreview()
  else previewDismissed.value = false
}
watch(narrow, n => {
  if (!n) drawerOpen.value = false
})
const cardCurrent = computed(() =>
  (narrow.value && !drawerOpen.value) || (!narrow.value && tab.value !== 'artifacts')
    ? null
    : shownArtifact.value,
)

// ── side threads ──
const asideOpen = ref(false)
const selectedSide = ref<string | null>(null)
const sideShown = computed(() => showWorkbench.value && tab.value === 'side')
/** The user asked for the Side view. On a narrow window it covers the conversation, so focus goes into it. */
async function openSide() {
  asideOpen.value = true
  previewDismissed.value = false
  workbenchTab.value = 'side'
  if (narrow.value || compact.value) setSide(false)
  if (narrow.value) {
    await nextTick()
    document.querySelector<HTMLElement>('.side-pane__heading')?.focus()
  }
}
/** A side question was just asked from the composer: select it in the pane; focus stays in the composer. */
function onAside(s: Session) {
  side.apply(s)
  selectedSide.value = s.id
  // the pane opens on its own only where it doesn't cover the conversation or squeeze the open details panel
  if (!narrow.value && !(compact.value && sideOpen.value)) {
    asideOpen.value = true
    previewDismissed.value = false
    workbenchTab.value = 'side'
    announcement.value = `Side question asked: ${s.title}. It shows in the preview pane.`
  } else
    toast({
      title: 'Side question asked',
      description: s.title,
      intent: 'info',
      action: { label: 'Open', onClick: () => void openSide() },
    })
}

// The palette's `>` list offers these while the screen is mounted (Fork and Ask a side question come from the header
// and the composer).
const withdraw: (() => void)[] = []
onMounted(() => {
  withdraw.push(
    registerCommand({
      id: 'session-toggle-files',
      label: 'Show files',
      icon: 'folder',
      run: toggleFiles,
    }),
    registerCommand({
      id: 'session-toggle-details',
      label: 'Toggle details',
      icon: 'panelRight',
      run: () => (sideOpen.value = !sideOpen.value),
    }),
    registerCommand({
      id: 'session-side-threads',
      label: 'Show side threads',
      icon: 'message',
      run: () => void openSide(),
    }),
  )
})
onBeforeUnmount(() => withdraw.splice(0).forEach(off => off()))

// ── actions that leave this page ──
function onForked(s: Session) {
  void router.push(`/s/${s.id}`)
}
function onDeleted() {
  const project = session.value?.project
  void router.push(project ? `/p/${project}/sessions` : '/')
}
</script>

<template>
  <div class="session-screen">
    <div class="session-screen__center">
      <div v-if="phase === 'loading'" class="session-screen__state" aria-busy="true">
        <IuSkeleton shape="row" :rows="1" />
        <IuSkeleton shape="text" :rows="8" />
      </div>

      <div v-else-if="phase === 'error'" class="session-screen__state">
        <IuErrorState
          variant="page"
          :title="error?.status === 404 ? 'Session not found' : 'Couldn’t load this session'"
          :body="
            error?.status === 404
              ? 'It may have been deleted, or the link is wrong.'
              : (error?.message ?? 'Something went wrong.')
          "
          :trace-id="`GET /api/sessions/${id} · ${error?.status || 'network'}`"
          @retry="load"
        />
      </div>

      <div v-else-if="phase === 'removed'" class="session-screen__state">
        <IuEmpty kind="cleared" title="This session was deleted">
          <RouterLink to="/">Back to Home</RouterLink>
        </IuEmpty>
      </div>

      <template v-else-if="session && view">
        <SessionHeader
          :session="session"
          :working="runningCount > 0"
          @updated="setRecord"
          @forked="onForked"
          @deleted="onDeleted"
        >
          <template #actions>
            <IuButton size="sm" variant="ghost" :aria-pressed="filesOpen" @click="toggleFiles"
              >Files</IuButton
            >
            <IuButton
              v-if="sideThreads.length || asideOpen"
              size="sm"
              variant="ghost"
              :aria-pressed="sideShown"
              :aria-label="`Side threads (${sideThreads.length})`"
              @click="openSide"
              >Side {{ sideThreads.length }}</IuButton
            >
            <IuButton
              ref="previewToggle"
              v-if="previewAvailable && !showWorkbench"
              size="sm"
              variant="ghost"
              :aria-pressed="false"
              aria-label="Show preview"
              @click="togglePreview"
              >Show preview</IuButton
            >
            <IuButton
              v-if="runningCount && !sideOpen"
              class="session-screen__running"
              variant="ghost"
              size="sm"
              :aria-label="`${runningCount} background ${runningCount === 1 ? 'task' : 'tasks'} running. Show details`"
              @click="sideOpen = true"
            >
              <IuBadge intent="neutral" dot>{{ runningCount }} running</IuBadge>
            </IuButton>
            <IuButton
              variant="ghost"
              size="sm"
              icon-only
              :aria-label="sideOpen ? 'Hide details' : 'Show details'"
              :title="sideOpen ? 'Hide details' : 'Show details'"
              :aria-pressed="sideOpen"
              @click="sideOpen = !sideOpen"
            >
              <template #icon><IuIcon name="panelRight" :size="14" /></template>
            </IuButton>
            <IuButton
              v-if="narrow && artifacts.length"
              variant="secondary"
              size="sm"
              aria-haspopup="dialog"
              :aria-expanded="drawerOpen"
              :aria-label="`Show artifacts (${artifacts.length})`"
              @click="openDrawer"
            >
              <template #icon><IuIcon name="panelRightOpen" :size="14" /></template>
              {{ artifacts.length }}
            </IuButton>
          </template>
        </SessionHeader>

        <div class="session-screen__body">
          <div class="session-screen__main">
            <IuCallout
              v-if="recordError"
              intent="danger"
              variant="subtle"
              :title="session.state === 'failed' ? 'The session failed' : 'The last turn failed'"
              class="session-screen__error"
            >
              {{ recordError }}
            </IuCallout>
            <SessionThread
              :rows="rows"
              :entries="view.detail.transcript"
              :root="session.cwd"
              :working="working"
              :harness="session.harness"
              :current-artifact="cardCurrent"
              @open-artifact="openArtifact"
              @open-task="openTask"
            />
            <div class="session-screen__dock">
              <NativeControls
                :harness="session.harness"
                :project="session.project"
                :session-id="session.id"
                :models="models"
                :model="session.model"
                :runtime-options="session.runtimeOptions"
                :disabled="
                  !session.live || session.state === 'running' || session.state === 'waiting'
                "
                @updated="setRecord"
                @history="load"
              />
              <SessionMessageQueue
                :session-id="session.id"
                :queue="session.messageQueue"
                @updated="setQueue"
              />
              <SessionComposer
                :harness="session.harness"
                :models="models"
                :model="session.model"
                :effort="session.effort"
                :permission-mode="session.permissionMode ?? 'default'"
                :permission-modes="permissionModes"
                @updated="setRecord"
                :session-id="session.id"
                :project="session.project"
                :state="session.state"
                :slash-commands="view.detail.slashCommands"
                :context="context"
                :replaced="session.pending.length > 0"
                :replacement-key="session.pending[0]?.id ?? null"
                :queued="session.messageQueue.messages.filter(m => m.state === 'queued').length"
                :queue-blocked="session.messageQueue.messages.some(m => m.state === 'uncertain')"
                @sent="setRecord"
                @queue="setQueue"
                @aside="onAside"
              >
                <template #replacement>
                  <SessionPrompts
                    :session-id="session.id"
                    :project="session.project"
                    :pending="session.pending"
                    :scopes="permissionScopes"
                  />
                </template>
              </SessionComposer>
            </div>
          </div>
          <IuSidePanel
            v-model:open="sideOpen"
            :width="420"
            :presentation="narrow || (showWorkbench && compact) ? 'overlay' : 'inline'"
            title="Details"
            aria-label="Session details"
          >
            <SessionSide
              :session="session"
              :tasks="activityItems"
              @updated="setRecord"
              @open-file="openFile"
              @open-artifact="openArtifact"
              @open-task="openTask"
            />
          </IuSidePanel>
        </div>
      </template>
    </div>

    <SessionWorkbench
      ref="workbench"
      v-if="session && view"
      v-show="showWorkbench"
      v-model:tab="tab"
      :session="session"
      :width="previewWidth"
      :resizable="showWorkbench && !narrow"
      @update:width="previewWidth = $event"
      @close="closePreview"
    >
      <template #activity
        ><TaskPreview
          ref="taskPreview"
          v-if="previewTask"
          :task="previewTask"
          :active="tab === 'activity'"
          :session-id="session!.id"
          :parent-title="session!.title"
          :harness="session!.harness"
          :modal="narrow"
          @close="closeTask"
      /></template>
      <template #side>
        <SideThreadPane
          v-if="asideOpen"
          v-model:selected="selectedSide"
          :parent-id="session!.id"
          :parent-entry-ids="parentEntryIds"
          :threads="sideThreads"
          :phase="side.phase.value"
          :error="side.error.value"
          @retry="side.reload"
          @promoted="side.apply"
          @discarded="side.remove"
        />
      </template>
      <template #artifacts>
        <ArtifactPanel
          v-if="artifacts.length && !narrow"
          ref="artifactPanel"
          :artifacts="artifacts"
          :show-tabs="false"
          :width="artifactPreviewWidth"
          presentation="inline"
          @answered="setRecord"
          @shown="(id, version) => (shownArtifact = { id, version })"
        />
      </template>
    </SessionWorkbench>
    <ArtifactPanel
      v-if="session && view && narrow && artifacts.length"
      ref="artifactPanel"
      v-model:open="drawerOpen"
      :artifacts="artifacts"
      presentation="overlay"
      @answered="setRecord"
      @shown="(id, version) => (shownArtifact = { id, version })"
      @close="onDrawerClosed"
    />

    <div class="session-screen__announce sr-only" aria-live="polite" role="status">
      {{ announcement }}
    </div>
  </div>
</template>

<style>
/* Two columns side by side, each scrolling inside itself; the drawer overlays this box on a narrow window. */
.session-screen {
  position: relative;
  height: 100%;
  min-height: 0;
  display: flex;
}
.session-screen__center {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.session-screen__state {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 20px;
  overflow-y: auto;
}
.session-screen__body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.session-screen__main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding-top: 12px;
}
.session-screen__error {
  flex: none;
  width: calc(100% - 40px);
  max-width: 820px;
  margin: 0 auto 8px;
  box-sizing: border-box;
}
.session-screen__dock {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 780px;
  margin: 0 auto;
  padding: 0 20px 16px;
  box-sizing: border-box;
  /* an open prompt scrolls inside the composer's slot; the dock itself must not clip, or the composer's slash
     menu, which floats above it, disappears */
  min-height: 0;
}
</style>
