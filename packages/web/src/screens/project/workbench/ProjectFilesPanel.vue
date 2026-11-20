<script setup lang="ts">
// The panel's Files tab, like the session preview's: a folder browser (breadcrumb, folders first, sizes and line
// changes) that opens a file in place with a preview (rendered or source Markdown, CSV table, highlighted code) and
// steps to its neighbours. "Changed" lists every file with uncommitted line changes; Heatmap is the full Files map
// with rename, move and trash.
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '@/api'
import { ApiRequestError } from '@/api/types'
import { IuButton } from '@/components/Button'
import { IuCodeBlock } from '@/components/CodeBlock'
import IuCsvViewer from '@/components/CsvViewer/CsvViewer.vue'
import { IuIcon } from '@/components/Icon'
import IuMarkdown from '@/components/Markdown/Markdown.vue'
import { IuSegmented } from '@/components/Segmented'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { fileKind as previewKind } from '@/screens/session/documents'
import { useResource } from '@/screens/shared/useResource'
import type { ProjectFileMap } from '@odin/shared/api'
import { useProject } from '../useProject'
import {
  buildTree,
  chain,
  deltaText,
  formatBytes,
  indexTree,
  nodeBytes,
  type FileNode,
} from '../files/files'
const FilesScreen = defineAsyncComponent(() => import('../files/FilesScreen.vue'))

const { detail } = useProject()
const api = useApi()
const route = useRoute()
const name = computed(() => detail.value.name)
const res = useResource<ProjectFileMap>(() => api.getProjectFileMap(name.value))
const tree = computed(() => buildTree(detail.value.title, res.data.value?.files ?? []))
const idx = computed(() => indexTree(tree.value))

const view = ref<'browse' | 'changed' | 'map'>('browse')
const folderId = ref('')
const openId = ref<string | null>(null)

watch(
  name,
  () => {
    res.reset()
    folderId.value = ''
    openId.value = null
    void res.load()
  },
  { immediate: true },
)

const crumbs = computed(() => chain(idx.value, folderId.value))
const byName = (a: FileNode, b: FileNode) =>
  Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name)
const entries = computed(() =>
  [...(idx.value.get(folderId.value)?.node.children ?? [])].sort(byName),
)
const changed = computed(() =>
  [...idx.value.values()]
    .map(e => e.node)
    .filter(n => n.kind !== 'folder' && n.delta && (n.delta.added || n.delta.removed))
    .sort((a, b) => a.id.localeCompare(b.id)),
)
/** The files the open one steps through: its folder's files, or the changed list. */
const siblings = computed(() =>
  view.value === 'changed' ? changed.value : entries.value.filter(n => n.kind !== 'folder'),
)
const opened = computed(() => {
  const n = openId.value === null ? null : idx.value.get(openId.value)?.node
  return n && n.kind !== 'folder' ? n : null
})
const position = computed(() => siblings.value.findIndex(n => n.id === openId.value))

function enter(n: FileNode) {
  if (n.kind === 'folder') folderId.value = n.id
  else openId.value = n.id
}
function step(by: number) {
  const next = siblings.value[position.value + by]
  if (next) openId.value = next.id
}

// `?file=<path>` (the command palette's Files results) opens that file once the map has loaded.
watch(
  [idx, () => route.query.file],
  ([index, file]) => {
    if (typeof file !== 'string' || openId.value === file) return
    const entry = index.get(file)
    if (!entry || entry.node.kind === 'folder') return
    view.value = 'browse'
    folderId.value = entry.parent ?? ''
    openId.value = file
  },
  { immediate: true },
)

const preview = ref<{ phase: 'loading' | 'ready' | 'error'; text: string; error: string }>({
  phase: 'loading',
  text: '',
  error: '',
})
const previewMessage = (e: unknown) =>
  e instanceof ApiRequestError && e.status === 415
    ? 'This file is binary or not UTF-8 text, so it has no preview.'
    : e instanceof ApiRequestError && e.status === 413
      ? 'This file is over 2 MiB, so it has no preview.'
      : e instanceof ApiRequestError && e.status === 404
        ? 'This file no longer exists.'
        : "Couldn't read this file."
const asSource = ref(false)
const kind = computed(() => (opened.value ? previewKind(opened.value.id) : 'text'))
watch(opened, async file => {
  asSource.value = false
  if (!file) return
  const id = file.id
  preview.value = { phase: 'loading', text: '', error: '' }
  try {
    const read = await api.readProjectFile(name.value, id)
    if (openId.value === id) preview.value = { phase: 'ready', text: read.content, error: '' }
  } catch (e) {
    if (openId.value === id) preview.value = { phase: 'error', text: '', error: previewMessage(e) }
  }
})
</script>

<template>
  <div class="pfiles">
    <div v-if="!opened" class="pfiles__bar">
      <IuSegmented
        :model-value="view"
        label="View"
        :options="[
          { value: 'browse', label: 'Browse' },
          { value: 'changed', label: changed.length ? `Changed ${changed.length}` : 'Changed' },
          { value: 'map', label: 'Heatmap' },
        ]"
        @update:model-value="view = $event as typeof view"
      />
    </div>

    <FilesScreen v-if="view === 'map' && !opened" class="pfiles__map" />

    <template v-else-if="!opened">
      <IuSkeleton v-if="res.phase.value === 'loading'" shape="table" :rows="6" />
      <IuErrorState
        v-else-if="res.phase.value === 'error'"
        title="Couldn't load the files"
        :body="res.error.value?.message ?? 'Unknown error'"
        :trace-id="`project.files.${res.error.value?.status ?? 0}`"
        @retry="res.load()"
      />
      <template v-else-if="view === 'browse'">
        <nav class="pfiles__crumbs" aria-label="Folder">
          <template v-for="(c, i) in crumbs" :key="c.id">
            <span v-if="i" class="pfiles__sep" aria-hidden="true">/</span>
            <button
              type="button"
              class="pfiles__crumb"
              :aria-current="c.id === folderId ? 'location' : undefined"
              :disabled="c.id === folderId"
              @click="folderId = c.id"
            >
              {{ c.name }}
            </button>
          </template>
        </nav>
        <IuEmpty v-if="!entries.length" title="Empty folder" body="Nothing in this folder." />
        <ul v-else class="pfiles__list" aria-label="Files">
          <li v-for="n in entries" :key="n.id">
            <button type="button" class="pfiles__row" @click="enter(n)">
              <IuIcon :name="n.kind === 'folder' ? 'folder' : 'file'" :size="14" />
              <span class="pfiles__name">{{ n.name }}</span>
              <span v-if="n.delta" class="pfiles__delta">{{ deltaText(n.delta) }}</span>
              <span class="pfiles__size">{{
                n.kind === 'folder' ? `${n.children?.length ?? 0} items` : formatBytes(nodeBytes(n))
              }}</span>
            </button>
          </li>
        </ul>
        <p v-if="res.data.value?.truncated" class="pfiles__note">
          The folder has more files than Odin maps; some are left out.
        </p>
      </template>
      <template v-else>
        <IuEmpty
          v-if="!changed.length"
          title="No changed files"
          body="Files with uncommitted line changes show up here."
        />
        <ul v-else class="pfiles__list" aria-label="Changed files">
          <li v-for="n in changed" :key="n.id">
            <button type="button" class="pfiles__row" @click="enter(n)">
              <IuIcon name="file" :size="14" />
              <span class="pfiles__name pfiles__path">{{ n.id }}</span>
              <span class="pfiles__delta">{{ deltaText(n.delta) }}</span>
            </button>
          </li>
        </ul>
      </template>
    </template>

    <section v-else class="pfiles__preview" aria-label="File preview">
      <div class="pfiles__previewbar">
        <IuButton size="sm" variant="ghost" @click="openId = null">
          <template #icon><IuIcon name="chevronLeft" :size="14" /></template>
          Back
        </IuButton>
        <span class="pfiles__spacer" />
        <span v-if="position >= 0" class="pfiles__size"
          >{{ position + 1 }} of {{ siblings.length }}</span
        >
        <IuButton
          size="sm"
          variant="ghost"
          icon-only
          aria-label="Previous file"
          :disabled="position <= 0"
          @click="step(-1)"
        >
          <template #icon><IuIcon name="chevronLeft" :size="14" /></template>
        </IuButton>
        <IuButton
          size="sm"
          variant="ghost"
          icon-only
          aria-label="Next file"
          :disabled="position < 0 || position >= siblings.length - 1"
          @click="step(1)"
        >
          <template #icon><IuIcon name="chevronRight" :size="14" /></template>
        </IuButton>
      </div>
      <div class="pfiles__head">
        <h3 class="pfiles__title">{{ opened.name }}</h3>
        <p class="pfiles__meta">
          <span class="pfiles__path">{{ opened.id }}</span>
          <span>{{ formatBytes(opened.bytes) }}</span>
          <span v-if="opened.delta" class="pfiles__delta">{{ deltaText(opened.delta) }}</span>
        </p>
        <IuSegmented
          v-if="kind === 'markdown' && preview.phase === 'ready'"
          :model-value="asSource ? 'source' : 'rendered'"
          label="View"
          :options="[
            { value: 'rendered', label: 'Rendered' },
            { value: 'source', label: 'Source' },
          ]"
          @update:model-value="asSource = $event === 'source'"
        />
      </div>
      <div class="pfiles__body">
        <p v-if="preview.phase === 'loading'" class="pfiles__note" role="status">Loading…</p>
        <p v-else-if="preview.phase === 'error'" class="pfiles__note">{{ preview.error }}</p>
        <IuCsvViewer v-else-if="kind === 'table'" :source="preview.text" :filename="opened.name" />
        <IuMarkdown
          v-else-if="kind === 'markdown' && !asSource"
          :source="preview.text"
          document
          size="md"
        />
        <IuCodeBlock v-else :code="preview.text" :filename="opened.name" line-numbers />
      </div>
    </section>
  </div>
</template>

<style>
.pfiles {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px 14px;
}
.pfiles__bar,
.pfiles__previewbar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.pfiles__spacer {
  flex: 1 1 0;
}
.pfiles__crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  font-size: var(--iu-font-size-12);
}
.pfiles__sep {
  color: var(--iu-text-muted);
}
.pfiles__crumb {
  padding: 2px 4px;
  border: 0;
  border-radius: var(--iu-radius-sm, 4px);
  background: none;
  color: var(--iu-text-2);
  font: inherit;
  cursor: pointer;
}
.pfiles__crumb:hover:not(:disabled) {
  background: var(--iu-hover);
  color: var(--iu-text-bright);
}
.pfiles__crumb:disabled {
  color: var(--iu-text-bright);
  cursor: default;
}
.pfiles__crumb:focus-visible,
.pfiles__row:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.pfiles__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.pfiles__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 6px;
  border: 0;
  border-radius: var(--iu-radius-sm, 4px);
  background: none;
  color: var(--iu-text);
  font: inherit;
  font-size: var(--iu-font-size-13);
  text-align: start;
  cursor: pointer;
}
.pfiles__row:hover {
  background: var(--iu-hover);
}
.pfiles__row > .iu-icon {
  flex: none;
  color: var(--iu-text-muted);
}
.pfiles__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pfiles__path {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.pfiles__delta,
.pfiles__size {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.pfiles__note {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.pfiles__preview {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.pfiles__head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.pfiles__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text-bright);
}
.pfiles__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  overflow-wrap: anywhere;
}
.pfiles__body {
  min-width: 0;
}
</style>
