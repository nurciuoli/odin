<script setup lang="ts">
// The workspace surface: a file browser above, and below it everything opened from it as documents in one tab strip.
// A text file is edited here; a .ipynb opens as a notebook (its kernel is the file's), read-only while it opens.
// "This session" heads the browser: the files the agent read or changed, newest first (fileActivity.ts).
import {
  computed,
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  toRaw,
} from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import type { SessionDetail, SessionFileListing, SessionTextFile } from '@odin/shared/api'
import type { NotebookCell, NotebookKernel, NotebookOutput } from '@odin/shared/notebooks'
import { useApi, ApiRequestError } from '@/api'
import { useDrafts } from '@/app/drafts'
import type { CsvSelection } from '@/components/CsvViewer/csv'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuIcon } from '@/components/Icon'
import type { MenuItem } from '@/components/Menu'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
const IuMarkdownEditor = defineAsyncComponent(
  () => import('@/components/MarkdownEditor/MarkdownEditor.vue'),
)
import { IuCsvViewer } from '@/components/CsvViewer'
import { IuDiff, diffLines } from '@/components/CodeBlock'
import DocumentHeader from './DocumentHeader.vue'
const NotebookCellView = defineAsyncComponent(() => import('./NotebookCell.vue'))
const NotebookDocument = defineAsyncComponent(() => import('./NotebookDocument.vue'))
import {
  baseName,
  closeDoc,
  docLabel,
  emptyDocs,
  fileIcon,
  fileKind,
  findDoc,
  openDoc,
  parentPath,
  parseIpynb,
  refForPath,
  untitledNotebook,
  type DocList,
  type DocRef,
  type OpenDoc,
} from './documents'
import { SURFACE } from './surface'
import { touchedFiles, type CellRef, type FileTouch } from './fileActivity'

const props = defineProps<{ session: SessionDetail }>()
const emit = defineEmits<{ hide: [] }>()
const api = useApi()
const sessionId = computed(() => props.session.id)
const composerDrafts = useDrafts()
function selectRows(path: string, selection: CsvSelection) {
  composerDrafts.append(
    sessionId.value,
    `Selected rows from ${path}:\n${JSON.stringify(selection, null, 2)}`,
  )
}

type Draft = SessionTextFile & { draft: string; mode: 'live' | 'source'; remote?: SessionTextFile }
/** A notebook document: its kernel once opened, and the file as read from disk until then (or if opening fails). */
interface NotebookState {
  phase: 'opening' | 'ready' | 'failed'
  kernel: NotebookKernel | null
  error: string
  /** The cells as saved on disk, for the read-only view. Null until read, or when the file is not a notebook. */
  cells: NotebookCell[] | null
  reading: boolean
  attached: boolean
  dirty: boolean
}

const touched = computed(() =>
  touchedFiles(props.session.transcript, {
    pending: props.session.pending,
    running: props.session.state === 'running',
    root: props.session.cwd,
  }).filter(f => f.inside),
)
/** A cell to show in a notebook, per path; a new object asks the notebook again. */
const touchLabel = (t?: FileTouch) =>
  t ? (t.meta ? `${t.verb.done} · ${t.meta}` : t.verb.done) : ''
const reveals = ref<Record<string, { cell: string }>>({})

const listing = ref<SessionFileListing>({ path: '', entries: [], truncated: false })
const listed = ref(false)
const listError = ref('')
const docs = ref<DocList>(emptyDocs())
const drafts = ref<Record<string, Draft>>({})
const notebooks = ref<Record<string, NotebookState>>({})
const error = ref('')
const busy = ref(false)
const expanded = ref(false)
const sidebarCollapsed = ref(false)
let browseRequest = 0
let openRequest = 0
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

const activeDoc = computed(() => docs.value.docs.find(d => d.key === docs.value.active))
const activePath = computed(() => activeDoc.value?.ref.path ?? '')
const active = computed(() => {
  const target = activeDoc.value?.ref
  return target?.kind === 'file' ? drafts.value[target.path] : undefined
})
const textDirty = (path: string) => {
  const d = drafts.value[path]
  return !!d && d.draft !== d.content
}
const isDirty = (doc: OpenDoc) =>
  doc.ref.kind === 'file' ? textDirty(doc.ref.path) : !!notebooks.value[doc.ref.path]?.dirty
const dirty = computed(() => docs.value.docs.some(isDirty))

async function browse(path = '') {
  const request = ++browseRequest
  listError.value = ''
  try {
    const next = await api.listSessionFiles(sessionId.value, path)
    if (request === browseRequest) listing.value = next
  } catch (e) {
    if (request === browseRequest) listError.value = message(e)
  } finally {
    if (request === browseRequest) listed.value = true
  }
}

// ── opening ──
async function openText(path: string) {
  const request = ++openRequest
  const target: DocRef = { kind: 'file', path }
  if (findDoc(docs.value, target)) {
    docs.value = openDoc(docs.value, target)
    return
  }
  try {
    const file = await api.readSessionFile(sessionId.value, path)
    drafts.value[path] = {
      ...file,
      draft: file.content,
      mode: /\.md$/i.test(path) ? 'live' : 'source',
    }
    docs.value = openDoc(docs.value, target, request === openRequest)
  } catch (e) {
    error.value = message(e)
  }
}
/** Open the notebook at `path`; `create` writes an empty one first. The file is shown read-only until its kernel is. */
async function openNotebookDoc(path: string, create = false) {
  const existing = notebooks.value[path]
  docs.value = openDoc(docs.value, { kind: 'notebook', path })
  if (existing && existing.phase !== 'failed') return
  const state: NotebookState = {
    phase: 'opening',
    kernel: null,
    error: '',
    cells: existing?.cells ?? null,
    reading: !create && !existing?.cells,
    attached: false,
    dirty: false,
  }
  notebooks.value[path] = state
  // `state` is the plain object; reads and writes go through the reactive one, and only while it is still the open one.
  const live = () => {
    const s = notebooks.value[path]
    return s && toRaw(s) === state ? s : undefined
  }
  if (state.reading)
    void api
      .readSessionFile(sessionId.value, path)
      .then(file => {
        const s = live()
        if (s) s.cells = parseIpynb(file.content)
      })
      .catch(() => {})
      .finally(() => {
        const s = live()
        if (s) s.reading = false
      })
  try {
    const kernel = await api.openNotebook(props.session.project, {
      path,
      create,
      sessionId: props.session.id,
    })
    let attached = (await api.sessionNotebooks(props.session.id)).map(k => k.id).includes(kernel.id)
    if (!attached) {
      await api.attachNotebook(props.session.id, kernel.id)
      attached = true
    }
    const s = live()
    if (!s) return
    s.attached = attached
    s.kernel = kernel
    s.phase = 'ready'
    if (create) void browse(listing.value.path)
  } catch (e) {
    const s = live()
    if (!s) return
    s.phase = 'failed'
    s.error = message(e)
  }
}
async function open(path: string) {
  error.value = ''
  const target = refForPath(path)
  if (target.kind === 'notebook') await openNotebookDoc(path)
  else await openText(path)
}
/** Open the notebook a kernel belongs to, scrolled to one of its cells. */
async function openCell(target: CellRef) {
  error.value = ''
  let path = Object.entries(notebooks.value).find(
    ([, nb]) => nb.kernel?.id === target.kernelId,
  )?.[0]
  if (!path) {
    try {
      path = (await api.sessionNotebooks(sessionId.value)).find(k => k.id === target.kernelId)?.path
    } catch (e) {
      error.value = message(e)
      return
    }
  }
  if (!path) {
    error.value = 'That notebook is no longer attached to this session.'
    return
  }
  reveals.value[path] = { cell: target.cellId }
  await openNotebookDoc(path)
}
/** Write `Untitled.ipynb` (or `Untitled-2.ipynb`, ...) in the folder on show, and open it. */
async function newNotebook() {
  error.value = ''
  try {
    const folder = listing.value.path
    const fresh = await api.listSessionFiles(sessionId.value, folder)
    await openNotebookDoc(
      untitledNotebook(
        folder,
        fresh.entries.map(e => e.name),
      ),
      true,
    )
  } catch (e) {
    error.value = message(e)
  }
}
async function refresh() {
  const d = active.value
  if (!d) return
  try {
    const next = await api.readSessionFile(sessionId.value, d.path)
    if (next.version === d.version) return
    if (d.draft !== d.content) d.remote = next
    else Object.assign(d, next, { draft: next.content })
  } catch (e) {
    error.value = message(e)
  }
}
async function save() {
  const d = active.value
  if (!d || busy.value) return
  const content = d.draft
  busy.value = true
  error.value = ''
  try {
    const next = await api.saveSessionFile(sessionId.value, d.path, content, d.version)
    Object.assign(d, next, { remote: undefined })
  } catch (e) {
    error.value = message(e)
    if (e instanceof ApiRequestError && e.status === 409) await refresh()
  } finally {
    busy.value = false
  }
}
function useDisk() {
  const d = active.value
  if (d?.remote && window.confirm('Discard this draft and load the disk version?')) {
    Object.assign(d, d.remote, { draft: d.remote.content, remote: undefined })
  }
}
function close(doc: OpenDoc) {
  if (isDirty(doc) && !window.confirm(`Discard unsaved changes to ${doc.ref.path}?`)) return
  docs.value = closeDoc(docs.value, doc.key)
  if (doc.ref.kind === 'file') delete drafts.value[doc.ref.path]
  else delete notebooks.value[doc.ref.path]
}
function fileMenu(d: Draft): MenuItem[] {
  return [
    { id: 'check', label: 'Check disk' },
    ...(fileKind(d.path) === 'markdown'
      ? [{ id: 'mode', label: d.mode === 'live' ? 'Edit source' : 'Live preview' }]
      : []),
  ]
}
function onFileMenu(d: Draft, id: string) {
  if (id === 'check') void refresh()
  else if (id === 'mode') d.mode = d.mode === 'live' ? 'source' : 'live'
}
/** Rich output needs the kernel's sandboxed frame; the read-only view keeps to plain text. */
const plainOutputs = (outputs: NotebookOutput[]): NotebookOutput[] =>
  outputs.map(o =>
    o.type === 'display'
      ? { type: 'display', data: { 'text/plain': o.data['text/plain'] ?? '' } }
      : o,
  )

// ── tabs ──
const tabButtons = ref<Record<string, HTMLButtonElement | null>>({})
function tabKey(event: KeyboardEvent, index: number) {
  const count = docs.value.docs.length
  const next = {
    ArrowRight: (index + 1) % count,
    ArrowLeft: (index - 1 + count) % count,
    Home: 0,
    End: count - 1,
  }[event.key]
  if (next === undefined) return
  event.preventDefault()
  const doc = docs.value.docs[next]
  if (!doc) return
  docs.value = openDoc(docs.value, doc.ref)
  tabButtons.value[doc.key]?.focus()
}

// ── surface chrome for the document headers ──
provide(SURFACE, {
  // The browser is above the documents; it is only out of sight when collapsed.
  browsing: computed(() => !sidebarCollapsed.value),
  showBrowser: () => {
    sidebarCollapsed.value = false
  },
  hidePanel: () => emit('hide'),
})

function keydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && expanded.value) {
    expanded.value = false
    e.preventDefault()
  }
}
function unload(e: BeforeUnloadEvent) {
  if (dirty.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
onBeforeRouteLeave(() => !dirty.value || window.confirm('Leave and discard unsaved file changes?'))
onBeforeRouteUpdate(() => !dirty.value || window.confirm('Leave and discard unsaved file changes?'))
onMounted(() => {
  window.addEventListener('keydown', keydown)
  void browse()
  window.addEventListener('beforeunload', unload)
  window.addEventListener('focus', refresh)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', keydown)
  window.removeEventListener('beforeunload', unload)
  window.removeEventListener('focus', refresh)
})
defineExpose({ open, openCell })
</script>

<template>
  <section
    class="session-files"
    :class="{ 'session-files--expanded': expanded }"
    aria-label="Workspace files"
  >
    <aside
      class="session-files__sidebar"
      :class="{ 'session-files__sidebar--collapsed': sidebarCollapsed }"
    >
      <div class="session-files__sidebar-header">
        <span class="session-files__sidebar-title">Files</span>
        <button
          type="button"
          class="session-files__sidebar-toggle"
          :aria-expanded="!sidebarCollapsed"
          :aria-label="sidebarCollapsed ? 'Expand file browser' : 'Collapse file browser'"
          @click="sidebarCollapsed = !sidebarCollapsed"
        >
          <IuIcon :name="sidebarCollapsed ? 'chevronRight' : 'chevronDown'" :size="14" />
        </button>
      </div>
      <div v-show="!sidebarCollapsed" class="session-files__sidebar-content">
        <section v-if="touched.length" class="session-files__session" aria-label="This session">
          <h3 class="session-files__section-title">This session</h3>
          <ul class="session-files__touched">
            <li v-for="file in touched" :key="file.path">
              <button
                type="button"
                class="session-files__entry"
                :class="{ 'session-files__entry--active': activePath === file.path }"
                :title="file.path"
                @click="open(file.path)"
              >
                <IuIcon :name="fileIcon(file.path)" :size="14" class="session-files__entry-icon" />
                <span class="session-files__entry-name">{{ file.path }}</span>
                <span class="session-files__entry-meta">{{ touchLabel(file.touches[0]) }}</span>
              </button>
            </li>
          </ul>
        </section>
        <div class="session-files__nav">
          <IuButton size="sm" variant="ghost" @click="browse()">Root</IuButton>
          <IuButton
            v-if="listing.path"
            size="sm"
            variant="ghost"
            @click="browse(parentPath(listing.path))"
            >Up</IuButton
          >
          <span class="session-files__spacer" />
          <IuButton size="sm" variant="ghost" @click="newNotebook">
            <template #icon><IuIcon name="plus" :size="14" /></template>
            New notebook
          </IuButton>
        </div>
        <div class="session-files__location">{{ listing.path || 'Working directory' }}</div>
        <div v-if="!listed" class="session-files__state" aria-busy="true">
          <IuSkeleton shape="text" :rows="4" />
        </div>
        <div v-else-if="listError" class="session-files__state">
          <IuErrorState
            title="Couldn’t list this folder"
            :body="listError"
            :trace-id="`GET files/${listing.path}`"
            @retry="browse(listing.path)"
          />
        </div>
        <template v-else>
          <div class="session-files__listing" aria-label="Directory entries">
            <button
              v-for="entry in listing.entries"
              :key="entry.path"
              type="button"
              class="session-files__entry"
              :class="{
                'session-files__entry--active': entry.kind === 'file' && activePath === entry.path,
              }"
              @click="entry.kind === 'directory' ? browse(entry.path) : open(entry.path)"
            >
              <IuIcon
                :name="entry.kind === 'directory' ? 'folder' : fileIcon(entry.path)"
                :size="14"
                class="session-files__entry-icon"
              />
              <span class="session-files__entry-name">{{ entry.name }}</span>
            </button>
            <p v-if="!listing.entries.length" class="session-files__truncated">
              This folder is empty.
            </p>
          </div>
          <p v-if="listing.truncated" class="session-files__truncated">
            Directory listing limited; open a subfolder to see more.
          </p>
        </template>
        <p v-if="error" class="session-files__error" role="alert">{{ error }}</p>
      </div>
    </aside>

    <div class="session-files__main">
      <div class="session-files__tabs">
        <div
          class="session-files__tablist"
          :role="docs.docs.length ? 'tablist' : undefined"
          aria-label="Open documents"
        >
          <div
            v-for="(doc, index) in docs.docs"
            :key="doc.key"
            class="session-files__tab"
            :class="{ 'session-files__tab--active': docs.active === doc.key }"
          >
            <button
              :id="`session-files-tab-${doc.key}`"
              :ref="el => (tabButtons[doc.key] = el as HTMLButtonElement | null)"
              type="button"
              role="tab"
              class="session-files__tab-select"
              :aria-selected="docs.active === doc.key"
              :aria-controls="`session-files-panel-${doc.key}`"
              :aria-label="`${docLabel(doc.ref).name}${isDirty(doc) ? ', unsaved changes' : ''}`"
              :tabindex="docs.active === doc.key ? 0 : -1"
              :title="doc.ref.path"
              @click="docs = openDoc(docs, doc.ref)"
              @keydown="tabKey($event, index)"
            >
              <IuIcon :name="docLabel(doc.ref).icon" :size="14" />
              <span class="session-files__tab-name">{{ docLabel(doc.ref).name }}</span>
              <span v-if="isDirty(doc)" class="session-files__tab-dot" aria-hidden="true">•</span>
            </button>
            <button
              type="button"
              class="session-files__tab-close"
              :aria-label="`Close ${doc.ref.path}`"
              @click="close(doc)"
            >
              <IuIcon name="close" :size="14" />
            </button>
          </div>
        </div>
        <IuButton
          size="sm"
          variant="ghost"
          icon-only
          :aria-pressed="expanded"
          :aria-label="expanded ? 'Exit full screen' : 'Full screen'"
          :title="expanded ? 'Exit full screen (Esc)' : 'Full screen'"
          @click="expanded = !expanded"
        >
          <template #icon><IuIcon :name="expanded ? 'close' : 'external'" :size="14" /></template>
        </IuButton>
      </div>

      <div
        v-for="doc in docs.docs"
        v-show="docs.active === doc.key"
        :id="`session-files-panel-${doc.key}`"
        :key="doc.key"
        role="tabpanel"
        :aria-labelledby="`session-files-tab-${doc.key}`"
        class="session-files__document"
      >
        <template v-if="doc.ref.kind === 'file' && drafts[doc.ref.path]">
          <template v-for="d in [drafts[doc.ref.path]!]" :key="d.path">
            <DocumentHeader
              :name="baseName(d.path)"
              :dir="parentPath(d.path)"
              :icon="fileIcon(d.path)"
              :status="d.draft !== d.content ? 'Unsaved changes' : 'Saved'"
              :menu="fileMenu(d)"
              @select="onFileMenu(d, $event)"
              @close="close(doc)"
            >
              <template #actions>
                <IuButton
                  size="sm"
                  variant="primary"
                  :disabled="busy || d.draft === d.content || !!d.remote"
                  @click="save"
                  >Save</IuButton
                >
              </template>
            </DocumentHeader>
            <div v-if="d.remote" class="session-files__conflict" role="status">
              <p>
                This file changed on disk. Your draft is preserved. Copy your changes before loading
                the disk version.
              </p>
              <IuButton size="sm" @click="useDisk">Load disk version</IuButton>
              <IuDiff :hunks="diffLines(d.remote.content, d.draft)" :filename="d.path" />
            </div>
            <IuCsvViewer
              v-if="fileKind(d.path) === 'table'"
              :source="d.content"
              :filename="d.path"
              @selection="selectRows(d.path, $event)"
            />
            <IuMarkdownEditor v-else v-model="d.draft" :mode="d.mode" :label="`Edit ${d.path}`" />
          </template>
        </template>
        <template v-else-if="doc.ref.kind === 'notebook' && notebooks[doc.ref.path]">
          <template v-for="nb in [notebooks[doc.ref.path]!]" :key="nb.kernel?.id ?? nb.phase">
            <NotebookDocument
              v-if="nb.phase === 'ready' && nb.kernel"
              :session="session"
              :kernel-id="nb.kernel.id"
              :attached="nb.attached"
              :reveal="reveals[doc.ref.path] ?? null"
              @update:dirty="nb.dirty = $event"
              @changed="nb.attached = true"
              @close="close(doc)"
            />
            <template v-else>
              <DocumentHeader
                :name="baseName(doc.ref.path)"
                :dir="parentPath(doc.ref.path)"
                icon="terminal"
                :status="nb.phase === 'opening' ? 'Opening' : 'Couldn’t open'"
                :tone="nb.phase === 'failed' ? 'failed' : null"
                @close="close(doc)"
              />
              <div class="session-files__notices">
                <IuCallout
                  v-if="nb.phase === 'failed'"
                  intent="danger"
                  variant="subtle"
                  live
                  title="Couldn’t open this notebook"
                >
                  {{ nb.error }} Showing the file as saved; it can’t be edited or run.
                  <template #actions>
                    <IuButton size="sm" @click="openNotebookDoc(doc.ref.path)">Try again</IuButton>
                  </template>
                </IuCallout>
              </div>
              <div v-if="nb.reading" class="session-files__state" aria-busy="true">
                <IuSkeleton shape="text" :rows="6" />
              </div>
              <div v-else-if="nb.cells" class="session-files__cells" aria-label="Notebook as saved">
                <NotebookCellView
                  v-for="(cell, index) in nb.cells"
                  :key="cell.id"
                  :cell="cell"
                  :source="cell.source"
                  :number="index + 1"
                  :outputs="plainOutputs(cell.outputs)"
                  readonly
                  detached
                />
                <p v-if="!nb.cells.length" class="session-files__truncated">
                  This notebook has no cells yet.
                </p>
              </div>
              <p v-else-if="nb.phase === 'failed'" class="session-files__truncated">
                This file couldn’t be read as a notebook.
              </p>
            </template>
          </template>
        </template>
      </div>

      <IuEmpty
        v-if="!docs.docs.length"
        class="session-files__empty"
        title="No files open"
        body="Select a file from the browser to view or edit it, or start a new notebook."
      />
    </div>
  </section>
</template>

<style>
.session-files {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
  color: var(--iu-text);
  font-size: var(--iu-font-size-13);
  background: var(--iu-ground);
}
.session-files--expanded {
  position: fixed;
  inset: 12px;
  z-index: 80;
  border: 1px solid var(--iu-border);
}
/* File browser on top, open documents below */
.session-files__sidebar {
  flex: 0 0 50%;
  width: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--iu-border-quiet);
  background: var(--iu-ground);
}
@media (prefers-reduced-motion: no-preference) {
  .session-files__sidebar {
    transition: flex-basis 0.15s ease;
  }
}
.session-files__sidebar--collapsed {
  flex: 0 0 36px;
}
.session-files__sidebar-header {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 36px;
  padding: 0 6px 0 10px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.session-files__sidebar-title {
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-muted);
  text-transform: uppercase;
  letter-spacing: var(--iu-tracking-caps-tight);
}
.session-files__sidebar-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text-muted);
  cursor: pointer;
}
.session-files__sidebar-toggle:hover {
  background: var(--iu-well);
  color: var(--iu-text);
}
.session-files__sidebar-toggle:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.session-files__sidebar-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.session-files__nav {
  display: flex;
  gap: 2px;
  padding: 6px;
}
.session-files__spacer {
  flex: 1;
}
.session-files__location {
  padding: 0 10px 6px;
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-files__state {
  padding: 8px 10px;
}
.session-files__listing {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px;
}
.session-files__entry {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text);
  font-size: var(--iu-font-size-13);
  text-align: left;
  cursor: pointer;
}
.session-files__entry:hover {
  background: var(--iu-well);
}
.session-files__entry--active {
  background: var(--iu-accent-quiet);
  color: var(--iu-accent);
}
.session-files__entry:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.session-files__entry-icon {
  flex: none;
  color: var(--iu-text-muted);
}
.session-files__session {
  flex: none;
  max-height: 40%;
  overflow-y: auto;
  padding: 6px 6px 4px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.session-files__section-title {
  margin: 0;
  padding: 2px 8px 4px;
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-muted);
}
.session-files__touched {
  margin: 0;
  padding: 0;
  list-style: none;
}
.session-files__entry-meta {
  flex: none;
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.session-files__entry-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-files__truncated,
.session-files__error {
  margin: 0;
  padding: 8px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.session-files__error {
  color: var(--iu-danger);
}
.session-files__main {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.session-files__tabs {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--iu-border-quiet);
  background: var(--iu-ground);
}
.session-files__tablist {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
}
.session-files__tab {
  flex: none;
  display: flex;
  align-items: center;
  border-radius: var(--iu-radius-sm);
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
}
.session-files__tab:hover,
.session-files__tab--active {
  background: var(--iu-well);
  color: var(--iu-text);
}
.session-files__tab-select {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 4px 6px 8px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.session-files__tab-select:focus-visible,
.session-files__tab-close:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.session-files__tab-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-files__tab-dot {
  color: var(--iu-accent);
}
.session-files__tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-right: 4px;
  padding: 0;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text-muted);
  cursor: pointer;
}
.session-files__tab-close:hover {
  background: var(--iu-border-quiet);
  color: var(--iu-text);
}
.session-files__document {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
.session-files__notices {
  flex: none;
  padding: 12px 16px 0;
}
.session-files__notices:empty {
  display: none;
}
.session-files__cells {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px;
}
.session-files__conflict {
  padding: 12px;
}
.session-files__empty {
  flex: 1;
}
</style>
