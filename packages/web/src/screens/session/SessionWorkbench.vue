<script setup lang="ts">
// The session's side panel. Its top is what is on show: the browser (the files the session touched, the whole working
// directory, outputs, notebooks, a filter) while nothing is open, else the open document under one header. Documents
// open into one list; with two or more things to choose from there is one row of tabs, which also holds the side
// threads and a background agent's activity. Below the top, the artifacts subpanel (the screen's ArtifactPanel) shows
// the session's artifacts in a sandboxed frame; it is collapsible and sits on the documents tab only.
import {
  computed,
  defineAsyncComponent,
  nextTick,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  useId,
  useTemplateRef,
  watch,
} from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import type { Artifact, SessionDetail } from '@odin/shared/api'
import type { NotebookKernel } from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuTabs, type Tab } from '@/components/Tabs'
import DocumentHeader from './DocumentHeader.vue'
import SessionFiles from './SessionFiles.vue'
import { touchedFiles, type CellRef } from './fileActivity'
import {
  baseName,
  closeDoc,
  docLabel,
  emptyDocs,
  findDoc,
  notebookFileName,
  openDoc,
  relativePath,
  replaceDoc,
  type DocList,
  type DocRef,
} from './documents'
import { SURFACE } from './surface'
import type { PreviewView } from './workbench'
const FileDocument = defineAsyncComponent(() => import('./FileDocument.vue'))
const NotebookDocument = defineAsyncComponent(() => import('./NotebookDocument.vue'))
const NotebookStart = defineAsyncComponent(() => import('./NotebookStart.vue'))

const props = withDefaults(
  defineProps<{
    session: SessionDetail
    /** The session's artifacts: the browser lists them under Outputs. */
    artifacts?: readonly Artifact[]
    /** The artifacts subpanel is in the column (not on a narrow window, where the artifacts have a drawer). */
    artifactPanel?: boolean
    width: number
    resizable?: boolean
    /** The side threads and a background agent's activity each get a tab while they exist. */
    hasSide?: boolean
    hasActivity?: boolean
  }>(),
  {
    artifacts: () => [],
    artifactPanel: false,
    resizable: false,
    hasSide: false,
    hasActivity: false,
  },
)

const emit = defineEmits<{
  close: []
  'update:width': [width: number]
  /** The browser chose an output: the screen selects it in the artifacts subpanel. */
  'open-artifact': [id: number]
  /** The browser asked to show a step of the conversation. */
  reveal: [entryId: string]
}>()

const tab = defineModel<PreviewView>('tab', { required: true })
const api = useApi()

// ── documents ──
const list = ref<DocList>(emptyDocs())
const dirty = ref<Record<string, boolean>>({})
const kernels = ref<NotebookKernel[]>([])
const attached = ref<string[]>([])
const active = computed(() => list.value.docs.find(d => d.key === list.value.active))
const label = (ref: DocRef) => docLabel(ref, { kernels: kernels.value })

async function loadKernels() {
  try {
    const [all, linked] = await Promise.all([
      api.listNotebooks(props.session.project),
      api.sessionNotebooks(props.session.id),
    ])
    kernels.value = all
    attached.value = linked.map(k => k.id)
  } catch {
    // the browser lists what it knows; a notebook that cannot load says so itself
  }
}
let unsubscribe: (() => void) | undefined
onMounted(() => {
  void loadKernels()
  unsubscribe = api.subscribe(
    event => {
      if (event.type === 'notebook.updated' && event.project === props.session.project)
        void loadKernels()
    },
    () => void loadKernels(),
  )
})
onBeforeUnmount(() => unsubscribe?.())

function resolve(ref: DocRef): DocRef {
  // a notebook file with a kernel behind it opens as that notebook
  if (ref.kind === 'file' && /\.ipynb$/i.test(ref.path)) {
    const kernel = kernels.value.find(k => notebookFileName(k.name) === baseName(ref.path))
    if (kernel) return { kind: 'notebook', kernelId: kernel.id }
  }
  return ref
}

/** Put a document on show. `fromBrowser`: the user chose it there, so focus follows it. */
function open(ref: DocRef, fromBrowser = false) {
  const target = resolve(ref)
  list.value = openDoc(list.value, target)
  tab.value = 'docs'
  browsing.value = false
  if (fromBrowser) void landOnDocument()
}
function openFile(path: string) {
  open({ kind: 'file', path: relativePath(props.session.cwd, path) })
}
// A notebook cell from a step in the thread: its notebook on show, scrolled to the cell.
const reveals = ref<Record<string, { cell: string }>>({})
function openCell(cell: CellRef) {
  open({ kind: 'notebook', kernelId: cell.kernelId })
  const key = findDoc(list.value, { kind: 'notebook', kernelId: cell.kernelId })?.key
  if (key) reveals.value[key] = { cell: cell.cellId }
}
/** Focus goes to the first control of the document the user just chose (keyboard users keep their place). */
async function landOnDocument() {
  await nextTick()
  const key = list.value.active
  const doc = key ? document.getElementById(`${idBase}-doc-${key}`) : null
  doc?.querySelector<HTMLElement>('button, input, textarea, [tabindex]')?.focus()
}
function select(key: string) {
  if (key === 'view:side' || key === 'view:activity') {
    tab.value = key === 'view:side' ? 'side' : 'activity'
    return
  }
  list.value = { ...list.value, active: key }
  tab.value = 'docs'
  browsing.value = false
}
function close(key: string) {
  if (dirty.value[key] && !window.confirm('Discard unsaved changes?')) return
  delete dirty.value[key]
  list.value = closeDoc(list.value, key)
  // nothing left open: the browser is what the panel shows
  if (list.value.active === null) browsing.value = true
}
function created(key: string, kernelId: string) {
  list.value = replaceDoc(list.value, key, { kind: 'notebook', kernelId })
  void loadKernels()
}

const anyDirty = computed(() => Object.values(dirty.value).some(Boolean))
const leaveOk = () => !anyDirty.value || window.confirm('Leave and discard unsaved changes?')
onBeforeRouteLeave(leaveOk)
onBeforeRouteUpdate(leaveOk)
function unload(e: BeforeUnloadEvent) {
  if (anyDirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onMounted(() => window.addEventListener('beforeunload', unload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', unload))

// ── the browser ──
const browsing = ref(true)
const browser = useTemplateRef<{ focus: () => Promise<void> }>('browser')
/** The browser is on show whenever nothing is open, too. */
const onBrowser = computed(() => browsing.value || !active.value)
function showBrowser() {
  browsing.value = true
  void browser.value?.focus()
}
provide(SURFACE, { browsing: onBrowser, showBrowser, hidePanel: () => emit('close') })

/** What the session read and changed, newest first, for the browser's first view. */
const touched = computed(() =>
  touchedFiles(props.session.transcript, {
    pending: props.session.pending,
    running:
      props.session.live &&
      (props.session.state === 'running' || props.session.state === 'waiting'),
    root: props.session.cwd,
  }),
)
const openDocuments = computed(() =>
  list.value.docs.map(d => ({
    key: d.key,
    ref: d.ref,
    name: label(d.ref).name,
    dirty: !!dirty.value[d.key],
  })),
)

// ── the tab row ──
const idBase = useId()
const tabs = computed<Tab[]>(() => [
  ...list.value.docs.map(d => ({
    id: d.key,
    label: label(d.ref).name + (dirty.value[d.key] ? ' •' : ''),
  })),
  ...(props.hasSide ? [{ id: 'view:side', label: 'Side threads' }] : []),
  ...(props.hasActivity ? [{ id: 'view:activity', label: 'Agent activity' }] : []),
])
const showTabs = computed(() => tabs.value.length > 1)
const activeTab = computed({
  get: () =>
    tab.value === 'side'
      ? 'view:side'
      : tab.value === 'activity'
        ? 'view:activity'
        : onBrowser.value
          ? ''
          : (list.value.active ?? ''),
  set: select,
})

defineExpose({
  openFile,
  openCell,
  showBrowser,
})

// ── width ──
const MIN_WIDTH = 480
const MAX_WIDTH = 960
const shell = ref<HTMLElement>()
const availableWidth = ref(typeof window === 'undefined' ? 1600 : window.innerWidth)
let observer: ResizeObserver | undefined
function measureAvailableWidth() {
  availableWidth.value = shell.value?.parentElement?.clientWidth || window.innerWidth
}
onMounted(() => {
  measureAvailableWidth()
  window.addEventListener('resize', measureAvailableWidth)
  if (typeof ResizeObserver !== 'undefined' && shell.value?.parentElement) {
    observer = new ResizeObserver(measureAvailableWidth)
    observer.observe(shell.value.parentElement)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measureAvailableWidth)
  observer?.disconnect()
})
const maxWidth = computed(() =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(availableWidth.value - 360))),
)
const boundedWidth = computed(() => Math.min(props.width, maxWidth.value))
watch(
  boundedWidth,
  value => {
    if (value !== props.width) emit('update:width', value)
  },
  { immediate: true },
)

const splitter = ref<HTMLElement>()
const drag = ref<{ id: number; startX: number; startWidth: number } | null>(null)
function stopDrag() {
  const current = drag.value
  drag.value = null
  if (current && splitter.value?.hasPointerCapture(current.id))
    splitter.value.releasePointerCapture(current.id)
  document.documentElement.classList.remove('session-workbench--resizing')
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  drag.value = { id: event.pointerId, startX: event.clientX, startWidth: boundedWidth.value }
  splitter.value?.setPointerCapture(event.pointerId)
  document.documentElement.classList.add('session-workbench--resizing')
}
function moveDrag(event: PointerEvent) {
  const current = drag.value
  if (!current || current.id !== event.pointerId) return
  emit(
    'update:width',
    Math.max(
      MIN_WIDTH,
      Math.min(maxWidth.value, current.startWidth + current.startX - event.clientX),
    ),
  )
}
function keyResize(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') emit('update:width', MIN_WIDTH)
  else if (event.key === 'End') emit('update:width', maxWidth.value)
  else
    emit(
      'update:width',
      Math.max(
        MIN_WIDTH,
        Math.min(
          maxWidth.value,
          boundedWidth.value + (event.key === 'ArrowLeft' ? 16 : -16) * (event.shiftKey ? 4 : 1),
        ),
      ),
    )
}
watch(
  () => props.resizable,
  value => {
    if (!value) stopDrag()
  },
)
onBeforeUnmount(stopDrag)
</script>
<template>
  <div
    ref="shell"
    class="session-workbench-shell"
    :style="{ '--session-workbench-width': `${boundedWidth}px` }"
  >
    <div
      v-if="resizable"
      ref="splitter"
      class="session-workbench__splitter"
      role="separator"
      aria-label="Resize content preview"
      aria-orientation="vertical"
      :aria-valuemin="MIN_WIDTH"
      :aria-valuemax="maxWidth"
      :aria-valuenow="boundedWidth"
      tabindex="0"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="stopDrag"
      @pointercancel="stopDrag"
      @lostpointercapture="stopDrag"
      @keydown="keyResize"
    />
    <div v-if="drag" class="session-workbench__drag-shield" aria-hidden="true" />
    <aside class="session-workbench" :data-tab="tab" aria-label="Content preview">
      <div v-if="showTabs" class="session-workbench__tabs">
        <IuTabs v-model="activeTab" :tabs="tabs" :panels="false" :id-base="idBase" />
      </div>
      <div class="session-workbench__content">
        <div v-show="tab === 'docs'" class="session-workbench__top">
          <section v-show="onBrowser" class="session-workbench__page" aria-label="Files">
            <DocumentHeader name="Files" icon="folder" :back="false" />
            <SessionFiles
              ref="browser"
              :session-id="session.id"
              :touched="touched"
              :artifacts="artifacts"
              :kernels="kernels"
              :attached="attached"
              :documents="openDocuments"
              @open="open($event, true)"
              @open-artifact="emit('open-artifact', $event)"
              @reveal="emit('reveal', $event)"
            />
          </section>
          <template v-for="d in list.docs" :key="d.key">
            <div
              v-show="!onBrowser && d.key === list.active"
              :id="`${idBase}-doc-${d.key}`"
              class="session-workbench__doc"
            >
              <FileDocument
                v-if="d.ref.kind === 'file'"
                :session-id="session.id"
                :path="d.ref.path"
                :active="d.key === list.active && tab === 'docs'"
                @update:dirty="dirty[d.key] = $event"
                @close="close(d.key)"
                @start-notebook="
                  list = replaceDoc(list, d.key, { kind: 'new-notebook', name: $event })
                "
              />
              <NotebookDocument
                v-else-if="d.ref.kind === 'notebook'"
                :session="session"
                :kernel-id="d.ref.kernelId"
                :attached="attached.includes(d.ref.kernelId)"
                :reveal="reveals[d.key] ?? null"
                @update:dirty="dirty[d.key] = $event"
                @changed="loadKernels"
                @close="close(d.key)"
              />
              <NotebookStart
                v-else
                :session="session"
                :name="d.ref.kind === 'new-notebook' ? d.ref.name : undefined"
                @created="created(d.key, $event)"
                @close="close(d.key)"
              />
            </div>
          </template>
        </div>
        <div v-show="tab === 'activity'" class="session-workbench__view">
          <slot name="activity" />
        </div>
        <div v-show="tab === 'side'" class="session-workbench__view">
          <slot name="side" />
        </div>
        <div v-if="artifactPanel" v-show="tab === 'docs'" class="session-workbench__artifacts">
          <slot name="artifacts" />
        </div>
      </div>
    </aside>
  </div>
</template>
<style>
.session-workbench-shell {
  position: relative;
  flex: none;
  width: var(--session-workbench-width);
  min-height: 0;
  min-width: 0;
  display: flex;
}
.session-workbench {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--iu-border-quiet);
  background: var(--iu-ground);
}
.session-workbench__tabs {
  flex: none;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}
/* the top of the panel takes what the artifacts subpanel leaves, and scrolls inside itself */
.session-workbench__content {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.session-workbench__top,
.session-workbench__doc,
.session-workbench__page,
.session-workbench__view {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
}
.session-workbench__top {
  flex: 1 1 0;
}
.session-workbench__artifacts {
  flex: none;
  min-width: 0;
  border-top: 1px solid var(--iu-border-quiet);
}
.session-workbench__splitter {
  position: relative;
  z-index: 3;
  flex: none;
  width: 8px;
  margin-right: -4px;
  cursor: col-resize;
  touch-action: none;
}
.session-workbench__splitter::after {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: transparent;
}
.session-workbench__splitter:hover::after,
.session-workbench__splitter:focus-visible::after {
  background: var(--iu-border-quiet);
}
.session-workbench__splitter:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.session-workbench__drag-shield {
  position: absolute;
  z-index: 2;
  inset: 0;
  cursor: col-resize;
}
.session-workbench--resizing,
.session-workbench--resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}
@media (max-width: 1024px) {
  .session-workbench-shell {
    position: absolute;
    inset: 48px 0 0;
    z-index: 20;
    width: 100%;
  }
  .session-workbench__splitter {
    display: none;
  }
  .session-workbench {
    width: 100%;
  }
}
</style>
