<script setup lang="ts">
// The session's document surface. Whatever is open (a workspace file, a notebook, an artifact) is shown in one slot
// under one header, and you move between open things with one row of tabs. The navigator (find a file, notebook or
// output) is a drawer that gets out of the way once something is open; the side threads and a background agent's
// activity are two more things the same tab row can show.
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
import DocumentNavigator from './DocumentNavigator.vue'
import {
  baseName,
  closeDoc,
  docLabel,
  emptyDocs,
  notebookFileName,
  openDoc,
  relativePath,
  replaceDoc,
  type DocList,
  type DocRef,
} from './documents'
import { artifactOrder } from './artifacts'
import { SURFACE } from './surface'
import type { PreviewView } from './workbench'
const FileDocument = defineAsyncComponent(() => import('./FileDocument.vue'))
const NotebookDocument = defineAsyncComponent(() => import('./NotebookDocument.vue'))
const NotebookStart = defineAsyncComponent(() => import('./NotebookStart.vue'))
const props = withDefaults(
  defineProps<{
    session: SessionDetail
    /** The artifacts this surface can show inline (none on a narrow window, where they have a drawer). */
    artifacts?: readonly Artifact[]
    width: number
    resizable?: boolean
    /** The side threads and a background agent's activity each get a tab while they exist. */
    hasSide?: boolean
    hasActivity?: boolean
  }>(),
  { artifacts: () => [], resizable: false, hasSide: false, hasActivity: false },
)
const emit = defineEmits<{
  close: []
  'update:width': [width: number]
  /** An artifact came forward; the screen's artifact viewer should show it (and this version, when given). */
  'select-artifact': [id: number, version?: number]
}>()
const tab = defineModel<PreviewView>('tab', { required: true })
const api = useApi()

// ── documents ──
const list = ref<DocList>(emptyDocs())
const dirty = ref<Record<string, boolean>>({})
const kernels = ref<NotebookKernel[]>([])
const attached = ref<string[]>([])
const active = computed(() => list.value.docs.find(d => d.key === list.value.active))
const hasDocs = computed(() => list.value.docs.length > 0)
const label = (ref: DocRef) => docLabel(ref, { artifacts: props.artifacts, kernels: kernels.value })

async function loadKernels() {
  try {
    const [all, linked] = await Promise.all([
      api.listNotebooks(props.session.project),
      api.sessionNotebooks(props.session.id),
    ])
    kernels.value = all
    attached.value = linked.map(k => k.id)
  } catch {
    // the navigator lists what it knows; a notebook that cannot load says so itself
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

// artifacts are documents too: the ones that exist open on arrival, new ones come forward, and one the user closed
// stays closed until it is opened again from the navigator
const seen = new Set<number>()
watch(
  () => artifactOrder(props.artifacts).map(a => a.id),
  ids => {
    const fresh = ids.filter(id => !seen.has(id))
    const arrival = seen.size > 0
    fresh.forEach(id => seen.add(id))
    fresh.forEach((id, i) => {
      list.value = openDoc(list.value, { kind: 'artifact', artifactId: id }, i === fresh.length - 1)
    })
    if (fresh.length && arrival) tab.value = 'docs'
  },
  { immediate: true },
)
function announceArtifact() {
  const doc = active.value
  if (doc?.ref.kind === 'artifact') emit('select-artifact', doc.ref.artifactId)
}

function resolve(ref: DocRef): DocRef {
  // a notebook file with a kernel behind it opens as that notebook
  if (ref.kind === 'file' && /\.ipynb$/i.test(ref.path)) {
    const kernel = kernels.value.find(k => notebookFileName(k.name) === baseName(ref.path))
    if (kernel) return { kind: 'notebook', kernelId: kernel.id }
  }
  return ref
}
function open(ref: DocRef, version?: number) {
  const target = resolve(ref)
  const wasBrowsing = browsing.value
  list.value = openDoc(list.value, target)
  tab.value = 'docs'
  browsing.value = false
  if (target.kind === 'artifact') emit('select-artifact', target.artifactId, version)
  // the drawer is gone; keep keyboard users on the surface, on the tab of what they opened
  if (wasBrowsing) void landOnTab()
}
async function landOnTab() {
  await nextTick()
  document.getElementById(`${idBase}-tab-${list.value.active}`)?.focus()
}
function openFile(path: string) {
  open({ kind: 'file', path: relativePath(props.session.cwd, path) })
}
function openNotebook() {
  open(
    kernels.value[0]
      ? { kind: 'notebook', kernelId: kernels.value[0].id }
      : { kind: 'new-notebook' },
  )
}
function showArtifact(id: number, version?: number) {
  open({ kind: 'artifact', artifactId: id }, version)
}
function select(key: string) {
  if (key === 'view:side' || key === 'view:activity') {
    tab.value = key === 'view:side' ? 'side' : 'activity'
    return
  }
  list.value = { ...list.value, active: key }
  tab.value = 'docs'
  browsing.value = false
  announceArtifact()
}
function close(key: string) {
  if (dirty.value[key] && !window.confirm('Discard unsaved changes?')) return
  delete dirty.value[key]
  list.value = closeDoc(list.value, key)
  announceArtifact()
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

// ── the tab row ──
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
        : (list.value.active ?? ''),
  set: select,
})
const idBase = useId()

// ── the navigator ──
const browsing = ref(false)
const drawerId = useId()
const navigator = useTemplateRef<{ focus: () => Promise<void> }>('navigator')
let opener: HTMLElement | null = null
async function toggleBrowse() {
  if (browsing.value) {
    closeBrowse()
    return
  }
  tab.value = 'docs'
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  // with nothing open the navigator is already the page
  if (hasDocs.value) browsing.value = true
  await nextTick()
  // the user asked for it
  await navigator.value?.focus()
}
function closeBrowse() {
  browsing.value = false
  if (opener?.isConnected) opener.focus()
  opener = null
}
provide(SURFACE, { browsing, drawerId, toggleBrowse, hidePanel: () => emit('close') })

defineExpose({
  openFile,
  openNotebook,
  showArtifact,
  hasDocs,
  activeKind: computed(() => active.value?.ref.kind ?? null),
})

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
        <div v-if="browsing && hasDocs" :id="drawerId" class="session-workbench__drawer">
          <DocumentNavigator
            ref="navigator"
            drawer
            :session-id="session.id"
            :artifacts="artifacts"
            :kernels="kernels"
            :attached="attached"
            @open="open"
            @close="closeBrowse"
          />
        </div>
        <div v-show="tab === 'docs'" class="session-workbench__docs">
          <section v-if="!hasDocs" class="session-workbench__page" aria-label="Workspace">
            <DocumentHeader name="Workspace" icon="folder" status="Nothing open" />
            <DocumentNavigator
              ref="navigator"
              :session-id="session.id"
              :artifacts="artifacts"
              :kernels="kernels"
              :attached="attached"
              @open="open"
            />
          </section>
          <template v-for="d in list.docs" :key="d.key">
            <div
              v-if="d.ref.kind !== 'artifact'"
              v-show="d.key === list.active"
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
          <div v-show="active?.ref.kind === 'artifact'" class="session-workbench__doc">
            <slot name="artifacts" :close="() => active && close(active.key)" />
          </div>
        </div>
        <div v-show="tab === 'activity'" class="session-workbench__view">
          <slot name="activity" />
        </div>
        <div v-show="tab === 'side'" class="session-workbench__view">
          <slot name="side" />
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
.session-workbench__content {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
.session-workbench__docs,
.session-workbench__doc,
.session-workbench__page,
.session-workbench__view {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
}
.session-workbench__drawer {
  position: absolute;
  z-index: 4;
  inset: 44px 0 auto;
  display: flex;
  max-height: calc(100% - 44px);
  flex-direction: column;
  box-shadow: var(--iu-shadow-raised);
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
