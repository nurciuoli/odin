<script setup lang="ts">
// Files: the project's tree as a treemap. Cell area is file size; Diff mode tints files by lines added and removed.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useApi } from '@/api'
import { ApiRequestError } from '@/api/types'
import { IuBadge } from '@/components/Badge'
import { IuCodeBlock } from '@/components/CodeBlock'
import { IuSegmented } from '@/components/Segmented'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { useResource } from '@/screens/shared/useResource'
import type { ProjectFileMap } from '@odin/shared/api'
import { useProject } from '../useProject'
import {
  buildTree,
  chain,
  deltaText,
  formatBytes,
  indexTree,
  lean,
  nodeBytes,
  tintPercent,
  under,
  type FileNode,
} from './files'
import { treemap } from './treemap'

const { detail } = useProject()
const api = useApi()
const res = useResource<ProjectFileMap>(() => api.getProjectFileMap(detail.value.name))
const tree = computed(() => buildTree(detail.value.title, res.data.value?.files ?? []))
const idx = computed(() => indexTree(tree.value))

const mode = ref('state')
const focusId = ref('')
const selectedId = ref<string | null>(null)

const name = computed(() => detail.value.name)
watch(
  name,
  () => {
    res.reset()
    focusId.value = ''
    selectedId.value = null
    void res.load()
  },
  { immediate: true },
)

const crumbs = computed(() => chain(idx.value, focusId.value))
const selected = computed(() => {
  const n = selectedId.value === null ? null : idx.value.get(selectedId.value)?.node
  return n && n.kind !== 'folder' ? n : null
})

// The selected file's text, fetched when it's selected; a late answer for an earlier file is dropped.
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
watch(selected, async file => {
  if (!file) return
  const id = file.id
  preview.value = { phase: 'loading', text: '', error: '' }
  try {
    const read = await api.readProjectFile(name.value, id)
    if (selected.value?.id === id) preview.value = { phase: 'ready', text: read.content, error: '' }
  } catch (e) {
    if (selected.value?.id === id)
      preview.value = { phase: 'error', text: '', error: previewMessage(e) }
  }
})

function drill(id: string) {
  focusId.value = id
  if (selectedId.value !== null && !under(idx.value, id, selectedId.value)) selectedId.value = null
}
function up() {
  const parent = idx.value.get(focusId.value)?.parent
  if (parent !== null && parent !== undefined) drill(parent)
}

const box = ref<HTMLElement | null>(null)
const size = ref({ w: 0, h: 0 })
let observer: ResizeObserver | undefined
function measure() {
  const el = box.value
  if (el) size.value = { w: el.clientWidth, h: el.clientHeight }
}
// The map only exists once the files have loaded, so (re)attach the observer whenever it appears.
watch(
  box,
  el => {
    observer?.disconnect()
    observer = undefined
    if (!el) return
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(el)
    }
  },
  { flush: 'post' },
)
onBeforeUnmount(() => observer?.disconnect())

interface Cell {
  node: FileNode
  x: number
  y: number
  w: number
  h: number
  /** A folder big enough to show its own contents inside. */
  nest: boolean
}

const GAP = 2
const HEAD = 28

function lay(node: FileNode, w: number, h: number, ox: number, oy: number, out: Cell[]) {
  const kids = node.children ?? []
  for (const r of treemap(
    kids.map(c => ({ id: c.id, value: nodeBytes(c) })),
    w,
    h,
  )) {
    const child = kids.find(c => c.id === r.id)!
    const cw = Math.max(0, r.w - GAP)
    const ch = Math.max(0, r.h - GAP)
    if (cw < 1 || ch < 1) continue
    const x = ox + r.x + GAP / 2
    const y = oy + r.y + GAP / 2
    const nest = child.kind === 'folder' && cw >= 88 && ch >= 64
    out.push({ node: child, x, y, w: cw, h: ch, nest })
    if (nest) lay(child, cw, ch - HEAD, x, y + HEAD, out)
  }
}

const cells = computed(() => {
  const out: Cell[] = []
  const root = idx.value.get(focusId.value)?.node
  if (root) lay(root, size.value.w, size.value.h, 0, 0, out)
  return out
})

const diff = computed(() => mode.value === 'diff')

function tint(node: FileNode): Record<string, string> | undefined {
  if (!diff.value || node.kind === 'folder' || !node.delta) return undefined
  const strength = tintPercent(node.delta)
  if (!strength) return undefined
  const l = lean(node.delta)
  const add = `color-mix(in srgb, var(--iu-positive) ${strength}%, var(--iu-surface-raised))`
  const rem = `color-mix(in srgb, var(--iu-danger) ${strength}%, var(--iu-surface-raised))`
  if (l.kind === 'add') return { background: add }
  if (l.kind === 'remove') return { background: rem }
  return { background: `linear-gradient(90deg, ${add} ${l.addPercent}%, ${rem} ${l.addPercent}%)` }
}

function cellStyle(c: Cell) {
  return {
    left: `${c.x}px`,
    top: `${c.y}px`,
    width: `${c.w}px`,
    height: `${c.h}px`,
    ...(c.nest ? {} : tint(c.node)),
  }
}

function press(c: Cell) {
  if (c.node.kind === 'folder') drill(c.node.id)
  else selectedId.value = c.node.id
}

const changed = computed(() => {
  let files = 0
  let added = 0
  let removed = 0
  for (const { node } of idx.value.values()) {
    if (node.delta) {
      files++
      added += node.delta.added
      removed += node.delta.removed
    }
  }
  return { files, added, removed }
})
</script>

<template>
  <div class="files" @keydown.backspace.prevent="up">
    <div class="files__bar">
      <nav class="files__crumbs" aria-label="Folder">
        <template v-for="(c, i) in crumbs" :key="c.id">
          <span v-if="i" class="files__sep" aria-hidden="true">/</span>
          <button
            type="button"
            class="files__crumb"
            :aria-current="c.id === focusId ? 'location' : undefined"
            :disabled="c.id === focusId"
            @click="drill(c.id)"
          >
            {{ c.name }}
          </button>
        </template>
      </nav>
      <p v-if="diff" class="files__legend" aria-label="Diff legend">
        <IuBadge intent="positive" dot>+ lines</IuBadge>
        <IuBadge intent="danger" dot>− lines</IuBadge>
        <span class="files__summary"
          >{{ changed.files }} files · +{{ changed.added }} −{{ changed.removed }}</span
        >
      </p>
      <IuSegmented
        v-model="mode"
        label="Map"
        :options="[
          { value: 'state', label: 'State' },
          { value: 'diff', label: 'Diff' },
        ]"
      />
    </div>

    <IuSkeleton v-if="res.phase.value === 'loading' && !res.data.value" shape="card" :rows="3" />
    <IuErrorState
      v-else-if="res.phase.value === 'error' && !res.data.value"
      title="Couldn't load the files"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`project.files.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />
    <IuEmpty
      v-else-if="!res.data.value?.files.length"
      title="No files"
      body="This project's folder is missing or empty."
    />
    <div v-else class="files__stage">
      <div ref="box" class="files__map" role="group" aria-label="File map">
        <template v-for="c in cells" :key="c.node.id">
          <div v-if="c.nest" class="files__cell files__cell--nest" :style="cellStyle(c)">
            <button
              type="button"
              class="files__open"
              :aria-label="`Open ${c.node.name}`"
              @click="drill(c.node.id)"
            >
              {{ c.node.name }}
            </button>
          </div>
          <button
            v-else
            type="button"
            class="files__cell files__cell--leaf"
            :class="{ 'files__cell--selected': c.node.id === selectedId }"
            :style="cellStyle(c)"
            :title="
              diff && c.node.delta ? `${c.node.name} · ${deltaText(c.node.delta)}` : c.node.name
            "
            :aria-pressed="c.node.kind === 'folder' ? undefined : c.node.id === selectedId"
            @click="press(c)"
          >
            <span v-if="c.w > 44 && c.h > 22" class="files__name">{{ c.node.name }}</span>
            <span v-if="diff && c.node.delta && c.w > 56 && c.h > 40" class="files__delta">{{
              deltaText(c.node.delta)
            }}</span>
          </button>
        </template>
      </div>

      <aside v-if="selected" class="files__plate" aria-label="File details">
        <p class="files__kicker">
          {{ diff ? deltaText(selected.delta) || 'unchanged' : formatBytes(selected.bytes) }}
        </p>
        <h2 class="files__title">{{ selected.name }}</h2>
        <p class="files__path">{{ selected.id }}</p>
        <p class="files__meta">
          <IuBadge variant="tag" size="xs">{{ selected.kind }}</IuBadge>
          <span>{{ formatBytes(selected.bytes) }}</span>
        </p>
        <p v-if="preview.phase === 'loading'" class="files__note" role="status">Loading…</p>
        <p v-else-if="preview.phase === 'error'" class="files__note">{{ preview.error }}</p>
        <IuCodeBlock
          v-else
          :code="preview.text"
          :filename="selected.name"
          line-numbers
          max-height="420px"
        />
      </aside>
    </div>
  </div>
</template>

<style>
.files {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 8px;
}
.files__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}
.files__crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  margin-right: auto;
  overflow-x: auto;
}
.files__crumb {
  padding: 4px 6px;
  border: 0;
  border-radius: var(--iu-radius-md);
  background: none;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
  white-space: nowrap;
  cursor: pointer;
}
.files__crumb:hover:not(:disabled) {
  color: var(--iu-text);
}
.files__crumb:disabled {
  color: var(--iu-text);
  cursor: default;
}
.files__sep {
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-13);
}
.files__legend {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.files__summary {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.files__stage {
  display: flex;
  gap: 12px;
  align-items: stretch;
}
.files__map {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 520px;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface-sunken);
  overflow: hidden;
}
.files__cell {
  position: absolute;
  overflow: hidden;
  box-sizing: border-box;
  background: var(--iu-surface-raised);
  color: var(--iu-text);
}
.files__cell--nest {
  background: var(--iu-surface-sunken);
  box-shadow: inset 0 0 0 1px var(--iu-border-quiet);
}
.files__open {
  display: flex;
  align-items: center;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  background: none;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
  text-align: left;
  cursor: pointer;
}
.files__cell--leaf {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  padding: 6px;
  border: 0;
  font-family: var(--iu-font-sans);
  text-align: left;
  cursor: pointer;
}
.files__cell--leaf:hover {
  box-shadow: inset 0 0 0 1px var(--iu-border-strong);
}
.files__cell--selected,
.files__cell--selected:hover {
  box-shadow: inset 0 0 0 2px var(--iu-accent);
}
.files__open:focus-visible,
.files__cell--leaf:focus-visible,
.files__crumb:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.files__name {
  width: 100%;
  overflow: hidden;
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.files__delta {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text);
}
.files__plate {
  flex: none;
  width: 440px;
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface);
}
.files__kicker {
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.files__title {
  margin: 6px 0 2px;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
  overflow-wrap: anywhere;
}
.files__path {
  margin: 0 0 10px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  overflow-wrap: anywhere;
}
.files__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
@media (max-width: 1099px) {
  .files__plate {
    width: 320px;
  }
}
.files__note {
  margin: 12px 0 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
@media (max-width: 799px) {
  .files__stage {
    flex-direction: column;
  }
  .files__plate {
    width: auto;
  }
}
</style>
