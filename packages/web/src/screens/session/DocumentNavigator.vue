<script setup lang="ts">
// Where to find something to open: a filter over the workspace's files, then the outputs, the notebooks and the
// folder you are in, in one list. It is a drawer under the surface's tab row, or the page itself while nothing is
// open; either way it hands back a document reference and the surface decides what to do with it.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import type { Artifact, FileMatch, SessionFileListing } from '@odin/shared/api'
import type { NotebookKernel } from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuField } from '@/components/Fields'
import { IuIcon, type IconName } from '@/components/Icon'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { baseName, fileIcon, notebookFileName, parentPath, type DocRef } from './documents'

const props = withDefaults(
  defineProps<{
    sessionId: string
    artifacts?: readonly Artifact[]
    kernels?: readonly NotebookKernel[]
    attached?: readonly string[]
    /** The drawer form closes on Escape; the page form has nothing to close. */
    drawer?: boolean
  }>(),
  { artifacts: () => [], kernels: () => [], attached: () => [], drawer: false },
)
const emit = defineEmits<{ open: [ref: DocRef]; close: [] }>()

const api = useApi()
const query = ref('')
const dir = ref('')
const listing = ref<SessionFileListing | null>(null)
const matches = ref<FileMatch[] | null>(null)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')
let request = 0

async function browse(path = dir.value) {
  const mine = ++request
  phase.value = 'loading'
  try {
    const next = await api.listSessionFiles(props.sessionId, path)
    if (mine !== request) return
    listing.value = next
    dir.value = next.path
    phase.value = 'ready'
  } catch (e) {
    if (mine !== request) return
    error.value = e instanceof Error ? e.message : String(e)
    phase.value = 'error'
  }
}
let timer: ReturnType<typeof setTimeout> | undefined
watch(query, q => {
  clearTimeout(timer)
  if (!q.trim()) {
    matches.value = null
    return
  }
  timer = setTimeout(async () => {
    const asked = q
    try {
      const result = await api.searchSessionFiles(props.sessionId, asked.trim())
      if (query.value === asked) matches.value = result.matches.filter(m => m.kind === 'file')
    } catch {
      if (query.value === asked) matches.value = []
    }
  }, 120)
})
onMounted(() => void browse(''))
onBeforeUnmount(() => clearTimeout(timer))

const crumbs = computed(() =>
  dir.value
    ? dir.value.split('/').map((name, i, all) => ({ name, path: all.slice(0, i + 1).join('/') }))
    : [],
)
const filtering = computed(() => query.value.trim() !== '')
const needle = computed(() => query.value.trim().toLowerCase())
const notebooks = computed(() =>
  props.kernels.filter(
    k => !needle.value || notebookFileName(k.name).toLowerCase().includes(needle.value),
  ),
)
const outputs = computed(() =>
  props.artifacts.filter(a => !needle.value || a.title.toLowerCase().includes(needle.value)),
)
const entries = computed(() =>
  [...(listing.value?.entries ?? [])].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1,
  ),
)

function pick(ref: DocRef) {
  emit('open', ref)
}
const iconFor = (path: string): IconName => fileIcon(path)

const field = useTemplateRef<{ focus?: () => void; $el?: HTMLElement }>('field')
async function focus() {
  await nextTick()
  field.value?.$el?.querySelector('input')?.focus()
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.drawer) {
    e.stopPropagation()
    emit('close')
  }
}
defineExpose({ focus })
</script>

<template>
  <nav
    class="doc-nav"
    :class="{ 'doc-nav--drawer': drawer }"
    aria-label="Open something"
    @keydown="onKeydown"
  >
    <IuField
      ref="field"
      v-model="query"
      class="doc-nav__filter"
      label="Filter files, notebooks and outputs"
      hide-label
      placeholder="Find a file, notebook or output"
      type="search"
      size="sm"
    />
    <div class="doc-nav__scroll">
      <template v-if="filtering">
        <section v-if="outputs.length" aria-label="Outputs">
          <h3 class="doc-nav__label">Outputs</h3>
          <button
            v-for="a in outputs"
            :key="a.id"
            type="button"
            class="doc-nav__row"
            @click="pick({ kind: 'artifact', artifactId: a.id })"
          >
            <IuIcon name="board" :size="14" /><span class="doc-nav__name">{{ a.title }}</span>
          </button>
        </section>
        <section v-if="notebooks.length" aria-label="Notebooks">
          <h3 class="doc-nav__label">Notebooks</h3>
          <button
            v-for="k in notebooks"
            :key="k.id"
            type="button"
            class="doc-nav__row"
            @click="pick({ kind: 'notebook', kernelId: k.id })"
          >
            <IuIcon name="terminal" :size="14" /><span class="doc-nav__name">{{
              notebookFileName(k.name)
            }}</span>
          </button>
        </section>
        <section aria-label="Files">
          <h3 class="doc-nav__label">Files</h3>
          <IuSkeleton v-if="matches === null" shape="row" :rows="3" />
          <button
            v-for="m in matches ?? []"
            :key="m.path"
            type="button"
            class="doc-nav__row"
            @click="pick({ kind: 'file', path: m.path })"
          >
            <IuIcon :name="iconFor(m.path)" :size="14" />
            <span class="doc-nav__name">{{ baseName(m.path) }}</span>
            <span class="doc-nav__dir">{{ parentPath(m.path) }}</span>
          </button>
          <p
            v-if="matches && !matches.length && !outputs.length && !notebooks.length"
            class="doc-nav__none"
          >
            Nothing matches “{{ query.trim() }}”.
          </p>
        </section>
      </template>

      <template v-else>
        <section v-if="outputs.length && !dir" aria-label="Outputs">
          <h3 class="doc-nav__label">Outputs</h3>
          <button
            v-for="a in outputs"
            :key="a.id"
            type="button"
            class="doc-nav__row"
            @click="pick({ kind: 'artifact', artifactId: a.id })"
          >
            <IuIcon name="board" :size="14" /><span class="doc-nav__name">{{ a.title }}</span>
            <span class="doc-nav__dir">v{{ a.latestVersion }}</span>
          </button>
        </section>
        <section v-if="!dir" aria-label="Notebooks">
          <h3 class="doc-nav__label">Notebooks</h3>
          <button
            v-for="k in notebooks"
            :key="k.id"
            type="button"
            class="doc-nav__row"
            @click="pick({ kind: 'notebook', kernelId: k.id })"
          >
            <IuIcon name="terminal" :size="14" /><span class="doc-nav__name">{{
              notebookFileName(k.name)
            }}</span>
            <span class="doc-nav__dir">{{
              attached.includes(k.id) ? k.state : 'not attached'
            }}</span>
          </button>
          <button
            type="button"
            class="doc-nav__row doc-nav__row--new"
            @click="pick({ kind: 'new-notebook' })"
          >
            <IuIcon name="plus" :size="14" /><span class="doc-nav__name">New notebook</span>
          </button>
        </section>
        <section aria-label="Files">
          <h3 class="doc-nav__label">
            <span>Files</span>
          </h3>
          <ol class="doc-nav__crumbs" aria-label="Folder">
            <li>
              <button
                type="button"
                class="doc-nav__crumb"
                :aria-current="!dir ? 'location' : undefined"
                @click="browse('')"
              >
                workspace
              </button>
            </li>
            <li v-for="c in crumbs" :key="c.path">
              <IuIcon name="chevronRight" :size="14" />
              <button
                type="button"
                class="doc-nav__crumb"
                :aria-current="c.path === dir ? 'location' : undefined"
                @click="browse(c.path)"
              >
                {{ c.name }}
              </button>
            </li>
          </ol>
          <IuSkeleton v-if="phase === 'loading'" shape="row" :rows="3" />
          <IuErrorState
            v-else-if="phase === 'error'"
            :title="'Couldn’t list files'"
            :body="error"
            trace-id="GET files"
            @retry="browse()"
          />
          <template v-else>
            <button
              v-for="entry in entries"
              :key="entry.path"
              type="button"
              class="doc-nav__row"
              @click="
                entry.kind === 'directory'
                  ? browse(entry.path)
                  : pick({ kind: 'file', path: entry.path })
              "
            >
              <IuIcon
                :name="entry.kind === 'directory' ? 'folder' : iconFor(entry.path)"
                :size="14"
              />
              <span class="doc-nav__name">{{ entry.name }}</span>
              <IuIcon v-if="entry.kind === 'directory'" name="chevronRight" :size="14" />
            </button>
            <IuEmpty v-if="!entries.length" kind="cleared" title="This folder is empty" />
            <p v-if="listing?.truncated" class="doc-nav__none">
              Listing limited; open a subfolder or filter to see more.
            </p>
          </template>
        </section>
      </template>
    </div>
  </nav>
</template>

<style>
.doc-nav {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  min-width: 0;
  padding: 12px 8px 8px;
}
.doc-nav--drawer {
  flex: none;
  max-height: min(60%, 460px);
  border-bottom: 1px solid var(--iu-border);
  background: var(--iu-ground);
  box-shadow: var(--iu-shadow-md, none);
}
.doc-nav:not(.doc-nav--drawer) {
  flex: 1;
}
.doc-nav__filter {
  flex: none;
  padding: 0 8px;
}
.doc-nav__scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.doc-nav__label {
  display: flex;
  margin: 8px 8px 2px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11-5);
  font-weight: var(--iu-font-weight-medium);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.doc-nav__row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  min-height: 28px;
  box-sizing: border-box;
  padding: 4px 8px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text);
  font: inherit;
  font-size: var(--iu-font-size-13);
  text-align: left;
  cursor: pointer;
}
.doc-nav__row > .iu-icon {
  flex: none;
  color: var(--iu-text-muted);
}
.doc-nav__row:hover {
  background: var(--iu-well);
}
.doc-nav__row:focus-visible,
.doc-nav__crumb:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.doc-nav__row--new {
  color: var(--iu-text-2);
}
.doc-nav__name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-nav__row > .iu-icon:last-child:not(:first-child) {
  margin-left: auto;
}
.doc-nav__dir {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  color: var(--iu-text-muted);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
}
.doc-nav__crumbs {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  margin: 0 8px 4px;
  padding: 0;
  list-style: none;
  color: var(--iu-text-muted);
}
.doc-nav__crumbs li {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.doc-nav__crumb {
  padding: 2px 4px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text-2);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  cursor: pointer;
}
.doc-nav__crumb:hover,
.doc-nav__crumb[aria-current='location'] {
  color: var(--iu-text);
}
.doc-nav__none {
  margin: 4px 8px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12-5);
}
</style>
