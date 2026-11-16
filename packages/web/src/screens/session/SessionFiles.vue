<script setup lang="ts">
// The side panel's browser: what the top of the panel shows while no document is on show. It opens on what the session
// did, the files it read or changed, newest first, each linked to its step in the conversation. The whole working
// directory is one click away as a tree that loads folder by folder. Outputs and notebooks sit beside them, and a
// filter searches all of it. Choosing something only says what: the surface decides how it opens.
import { computed, nextTick, ref, useId, useTemplateRef, watch } from 'vue'
import type { Artifact, FileMatch, SessionFileListing } from '@odin/shared/api'
import type { NotebookKernel } from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import PanelLine from './PanelLine.vue'
import type { TouchedFile } from './fileActivity'
import { baseName, fileIcon, notebookFileName, parentPath, type DocRef } from './documents'

const props = withDefaults(
  defineProps<{
    sessionId: string
    /** What the session touched, newest first (fileActivity.ts). */
    touched?: TouchedFile[]
    artifacts?: readonly Artifact[]
    kernels?: readonly NotebookKernel[]
    /** Notebook kernels linked to this session. */
    attached?: readonly string[]
    /** The documents open on the surface, listed so one can be brought back. */
    documents?: { key: string; ref: DocRef; name: string; dirty: boolean }[]
  }>(),
  {
    touched: () => [],
    artifacts: () => [],
    kernels: () => [],
    attached: () => [],
    documents: () => [],
  },
)
const emit = defineEmits<{
  open: [ref: DocRef]
  'open-artifact': [id: number]
  /** Point the thread at a step (its entry id). */
  reveal: [entryId: string]
}>()

const api = useApi()
const idBase = useId()
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ── the filter ──
const query = ref('')
const filtering = computed(() => query.value.trim() !== '')
const needle = computed(() => query.value.trim().toLowerCase())
const matches = ref<FileMatch[] | null>(null)
const outputs = computed(() =>
  props.artifacts.filter(a => !needle.value || a.title.toLowerCase().includes(needle.value)),
)
const notebooks = computed(() =>
  props.kernels.filter(
    k => !needle.value || notebookFileName(k.name).toLowerCase().includes(needle.value),
  ),
)
let timer: ReturnType<typeof setTimeout> | undefined
watch(query, q => {
  clearTimeout(timer)
  if (!q.trim()) {
    matches.value = null
    return
  }
  timer = setTimeout(async () => {
    const asked = q.trim()
    try {
      const result = await api.searchSessionFiles(props.sessionId, asked)
      if (query.value.trim() === asked)
        matches.value = result.matches.filter(m => m.kind === 'file')
    } catch {
      if (query.value.trim() === asked) matches.value = []
    }
  }, 120)
})

// ── this session: what it touched ──
const touchedByPath = computed(() => new Map(props.touched.map(f => [f.path, f])))
const unfolded = ref(new Set<string>())
function toggle(key: string) {
  if (unfolded.value.has(key)) unfolded.value.delete(key)
  else unfolded.value.add(key)
}
const dirtyPaths = computed(
  () =>
    new Set(props.documents.flatMap(d => (d.dirty && d.ref.kind === 'file' ? [d.ref.path] : []))),
)
function fileStatus(f: TouchedFile) {
  if (dirtyPaths.value.has(f.path)) return 'awaiting' as const
  return f.touches[0]!.call.status === 'failed' ? ('failed' as const) : undefined
}
function fileMeta(f: TouchedFile): string {
  if (dirtyPaths.value.has(f.path)) return 'unsaved'
  return [f.touches[0]!.meta, f.touches.length > 1 ? `×${f.touches.length}` : '']
    .filter(Boolean)
    .join(' · ')
}

// ── the working directory: a tree that loads folder by folder ──
type Entry = SessionFileListing['entries'][number]
const browsing = ref(false)
const listings = ref<Record<string, { entries: Entry[]; truncated: boolean }>>({})
const loading = ref(new Set<string>())
const openDirs = ref(new Set<string>())
const treeError = ref('')
async function load(path: string) {
  loading.value.add(path)
  treeError.value = ''
  try {
    const next = await api.listSessionFiles(props.sessionId, path)
    listings.value[path] = { entries: next.entries, truncated: next.truncated }
  } catch (e) {
    treeError.value = message(e)
  } finally {
    loading.value.delete(path)
  }
}
async function browse() {
  browsing.value = true
  if (!listings.value['']) await load('')
}
function toggleDir(path: string) {
  if (openDirs.value.has(path)) openDirs.value.delete(path)
  else {
    openDirs.value.add(path)
    if (!listings.value[path]) void load(path)
  }
}
interface TreeRow {
  entry: Entry
  depth: number
}
const rows = computed(() => {
  const out: TreeRow[] = []
  const walk = (path: string, depth: number) => {
    for (const entry of listings.value[path]?.entries ?? []) {
      out.push({ entry, depth })
      if (entry.kind === 'directory' && openDirs.value.has(entry.path)) walk(entry.path, depth + 1)
    }
  }
  walk('', 0)
  return out
})
const truncatedDirs = computed(() =>
  Object.entries(listings.value)
    .filter(([path, l]) => l.truncated && (path === '' || openDirs.value.has(path)))
    .map(([path]) => path || 'the working directory'),
)
const touchWord = (path: string) => {
  const f = touchedByPath.value.get(path)
  return f ? (f.changed ? 'changed' : 'read') : ''
}

// ── opening things: each one says what it is, the surface opens it ──
const openFile = (path: string) => emit('open', { kind: 'file', path })
const openNotebook = (kernelId: string) => emit('open', { kind: 'notebook', kernelId })
function activate(entry: Entry) {
  if (entry.kind === 'directory') toggleDir(entry.path)
  else openFile(entry.path)
}

// ── focus, asked for by the surface after the user went back to the browser ──
const field = useTemplateRef<{ $el?: HTMLElement }>('field')
async function focus() {
  await nextTick()
  field.value?.$el?.querySelector('input')?.focus()
}
defineExpose({ focus })
</script>

<template>
  <section class="session-files" aria-label="Files">
    <div class="session-files__filter">
      <IuField
        ref="field"
        v-model="query"
        label="Filter files, notebooks and outputs"
        hide-label
        placeholder="Find a file, notebook or output"
        type="search"
        size="sm"
      />
    </div>

    <div class="session-files__scroll">
      <!-- this session, or the whole working directory (not while filtering) -->
      <template v-if="!filtering && !browsing">
        <div class="session-files__bar">
          <h3 class="session-files__label">This session</h3>
          <IuButton v-if="touched.length" size="sm" variant="link" @click="browse">
            Browse all files
          </IuButton>
        </div>
        <ul
          v-if="touched.length"
          class="session-files__rows"
          aria-label="Files this session touched"
        >
          <li v-for="(f, i) in touched" :key="f.path">
            <PanelLine
              :verb="f.touches[0]!.verb.done"
              :meta="fileMeta(f)"
              :status="fileStatus(f)"
              :interactive="f.inside"
              :title="f.inside ? undefined : 'Outside the working directory'"
              @activate="openFile(f.path)"
            >
              {{ f.path }}
              <template #actions>
                <IuButton
                  v-if="f.touches.length > 1"
                  size="sm"
                  variant="ghost"
                  icon-only
                  :aria-expanded="unfolded.has(f.path)"
                  :aria-controls="`${idBase}-steps-${i}`"
                  :aria-label="`${f.touches.length} steps on ${f.path}`"
                  :title="`${f.touches.length} steps`"
                  @click="toggle(f.path)"
                >
                  <template #icon
                    ><IuIcon
                      :name="unfolded.has(f.path) ? 'chevronDown' : 'chevronRight'"
                      :size="14"
                  /></template>
                </IuButton>
                <IuButton
                  size="sm"
                  variant="ghost"
                  icon-only
                  :aria-label="`Show ${f.path} in the conversation`"
                  title="Show in thread"
                  @click="emit('reveal', f.touches[0]!.entryId)"
                >
                  <template #icon><IuIcon name="message" :size="14" /></template>
                </IuButton>
              </template>
            </PanelLine>
            <ul
              v-if="unfolded.has(f.path)"
              :id="`${idBase}-steps-${i}`"
              class="session-files__steps"
            >
              <li v-for="t in f.touches" :key="t.entryId">
                <PanelLine
                  quiet
                  interactive
                  :verb="t.verb.done"
                  :meta="t.meta"
                  :status="t.call.status === 'failed' ? 'failed' : undefined"
                  @activate="emit('reveal', t.entryId)"
                >
                  show in conversation
                </PanelLine>
              </li>
            </ul>
          </li>
        </ul>
        <IuEmpty
          v-else
          kind="first-run"
          title="No files touched yet"
          body="Files the agent reads, writes or changes appear here as it works."
        >
          <IuButton size="sm" variant="secondary" @click="browse">Browse all files</IuButton>
        </IuEmpty>
      </template>

      <template v-else-if="!filtering">
        <div class="session-files__bar">
          <IuButton size="sm" variant="link" @click="browsing = false">
            <template #icon><IuIcon name="chevronLeft" :size="14" /></template>
            This session
          </IuButton>
        </div>
        <IuSkeleton v-if="loading.has('') && !rows.length" shape="text" :rows="5" />
        <IuErrorState
          v-else-if="treeError && !rows.length"
          title="Couldn’t list files"
          :body="treeError"
          trace-id="GET files"
          @retry="load('')"
        />
        <ul v-else class="session-files__rows session-files__tree" aria-label="Working directory">
          <li v-for="{ entry, depth } in rows" :key="entry.path">
            <PanelLine
              interactive
              prose
              :expanded="entry.kind === 'directory' ? openDirs.has(entry.path) : undefined"
              :meta="entry.kind === 'file' ? touchWord(entry.path) : ''"
              @activate="activate(entry)"
            >
              <template #lead>
                <span class="session-files__indent" :style="{ width: `${depth * 14}px` }" />
                <IuIcon
                  class="session-files__icon"
                  :name="
                    entry.kind === 'directory'
                      ? openDirs.has(entry.path)
                        ? 'chevronDown'
                        : 'chevronRight'
                      : fileIcon(entry.path)
                  "
                  :size="14"
                />
              </template>
              {{ entry.name }}
            </PanelLine>
          </li>
        </ul>
        <p v-for="dir in truncatedDirs" :key="dir" class="session-files__note">
          The listing for {{ dir }} is limited; open a subfolder to see more.
        </p>
        <IuCallout v-if="treeError && rows.length" intent="danger" variant="subtle">
          {{ treeError }}
        </IuCallout>
      </template>

      <!-- a filter: the matches, by kind -->
      <section v-if="outputs.length" aria-label="Outputs">
        <h3 class="session-files__label">Outputs</h3>
        <ul class="session-files__rows">
          <li v-for="a in outputs" :key="a.id">
            <PanelLine
              interactive
              prose
              :meta="`v${a.latestVersion}`"
              @activate="emit('open-artifact', a.id)"
            >
              <template #lead><IuIcon name="board" :size="14" /></template>
              {{ a.title }}
            </PanelLine>
          </li>
        </ul>
      </section>
      <section v-if="notebooks.length || !filtering" aria-label="Notebooks">
        <h3 class="session-files__label">Notebooks</h3>
        <ul class="session-files__rows">
          <li v-for="k in notebooks" :key="k.id">
            <PanelLine
              interactive
              prose
              :meta="attached.includes(k.id) ? k.state : 'not attached'"
              @activate="openNotebook(k.id)"
            >
              <template #lead><IuIcon name="terminal" :size="14" /></template>
              {{ notebookFileName(k.name) }}
            </PanelLine>
          </li>
          <li v-if="!filtering">
            <PanelLine interactive prose @activate="emit('open', { kind: 'new-notebook' })">
              <template #lead><IuIcon name="plus" :size="14" /></template>
              New notebook
            </PanelLine>
          </li>
        </ul>
      </section>
      <section v-if="filtering" aria-label="Files">
        <h3 class="session-files__label">Files</h3>
        <IuSkeleton v-if="matches === null" shape="row" :rows="3" />
        <ul v-else-if="matches.length" class="session-files__rows">
          <li v-for="m in matches" :key="m.path">
            <PanelLine interactive :meta="parentPath(m.path)" @activate="openFile(m.path)">
              <template #lead><IuIcon :name="fileIcon(m.path)" :size="14" /></template>
              {{ baseName(m.path) }}
            </PanelLine>
          </li>
        </ul>
        <p v-else-if="!outputs.length && !notebooks.length" class="session-files__note">
          Nothing matches “{{ query.trim() }}”.
        </p>
      </section>
      <section v-if="!filtering && documents.length" aria-label="Open documents">
        <h3 class="session-files__label">Open</h3>
        <ul class="session-files__rows">
          <li v-for="d in documents" :key="d.key">
            <PanelLine
              interactive
              prose
              :meta="d.dirty ? 'unsaved' : ''"
              :status="d.dirty ? 'awaiting' : undefined"
              @activate="emit('open', d.ref)"
            >
              {{ d.name }}
            </PanelLine>
          </li>
        </ul>
      </section>
    </div>
  </section>
</template>

<style>
.session-files {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  color: var(--iu-text);
  font-size: var(--iu-font-size-13);
  background: var(--iu-ground);
}
.session-files__filter {
  flex: none;
  padding: 10px 14px 6px;
}
.session-files__scroll {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
  padding: 4px 14px 16px;
}
.session-files__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.session-files__label {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  font-weight: var(--iu-font-weight-regular);
  color: var(--iu-text-muted);
}
.session-files__rows,
.session-files__steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.session-files__steps {
  padding: 0 0 4px 18px;
}
.session-files__tree .panel-line__main {
  min-height: 26px;
}
.session-files__indent {
  flex: none;
}
.session-files__icon {
  flex: none;
  color: var(--iu-text-muted);
}
.session-files__note {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
</style>
