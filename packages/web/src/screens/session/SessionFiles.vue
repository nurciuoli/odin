<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import type { SessionFileListing, SessionTextFile } from '@odin/shared/api'
import { useApi, ApiRequestError } from '@/api'
import { useDrafts } from '@/app/drafts'
import type { CsvSelection } from '@/components/CsvViewer/csv'
import { IuButton } from '@/components/Button'
const IuMarkdownEditor = defineAsyncComponent(
  () => import('@/components/MarkdownEditor/MarkdownEditor.vue'),
)
import { IuCsvViewer } from '@/components/CsvViewer'
import { IuDiff, diffLines } from '@/components/CodeBlock'

const props = defineProps<{ sessionId: string }>()
const api = useApi()
const composerDrafts = useDrafts()
function selectRows(path: string, selection: CsvSelection) {
  composerDrafts.append(
    props.sessionId,
    `Selected rows from ${path}:\n${JSON.stringify(selection, null, 2)}`,
  )
}
type Draft = SessionTextFile & { draft: string; mode: 'live' | 'source'; remote?: SessionTextFile }
const listing = ref<SessionFileListing>({ path: '', entries: [], truncated: false })
const drafts = ref<Draft[]>([])
const selected = ref('')
const active = computed(() => drafts.value.find(d => d.path === selected.value))
const error = ref('')
const busy = ref(false)
const expanded = ref(false)
const fullPreview = ref(false)
let browseRequest = 0
let openRequest = 0
const dirty = computed(() => drafts.value.some(d => d.draft !== d.content))
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
async function browse(path = '') {
  const request = ++browseRequest
  error.value = ''
  try {
    const next = await api.listSessionFiles(props.sessionId, path)
    if (request === browseRequest) listing.value = next
  } catch (e) {
    error.value = message(e)
  }
}
async function open(path: string) {
  const request = ++openRequest
  error.value = ''
  const existing = drafts.value.find(d => d.path === path)
  if (existing) {
    selected.value = path
    return
  }
  try {
    const file = await api.readSessionFile(props.sessionId, path)
    drafts.value.push({
      ...file,
      draft: file.content,
      mode: /\.md$/i.test(path) ? 'live' : 'source',
    })
    if (request === openRequest) selected.value = path
  } catch (e) {
    error.value = message(e)
  }
}
async function refresh() {
  const d = active.value
  if (!d) return
  try {
    const next = await api.readSessionFile(props.sessionId, d.path)
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
    const next = await api.saveSessionFile(props.sessionId, d.path, content, d.version)
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
function close(d: Draft) {
  if (d.draft !== d.content && !window.confirm(`Discard unsaved changes to ${d.path}?`)) return
  drafts.value = drafts.value.filter(x => x !== d)
  if (selected.value === d.path) selected.value = drafts.value.at(-1)?.path ?? ''
}
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
defineExpose({ open })
</script>

<template>
  <section
    class="session-files"
    :class="{ 'session-files--expanded': expanded }"
    aria-label="Workspace files"
  >
    <div class="session-files__toolbar">
      <IuButton size="sm" variant="ghost" @click="browse()">Root</IuButton>
      <IuButton
        v-if="listing.path"
        size="sm"
        variant="ghost"
        @click="browse(listing.path.split('/').slice(0, -1).join('/'))"
        >Up</IuButton
      >
      <span class="session-files__location">{{ listing.path || 'Working directory' }}</span>
      <IuButton
        size="sm"
        variant="ghost"
        :aria-pressed="fullPreview"
        @click="fullPreview = !fullPreview"
        >{{ fullPreview ? 'Show browser' : 'Full preview' }}</IuButton
      >
      <IuButton size="sm" variant="ghost" :aria-pressed="expanded" @click="expanded = !expanded">{{
        expanded ? 'Collapse' : 'Expand'
      }}</IuButton>
    </div>
    <div v-show="!fullPreview" class="session-files__listing" aria-label="Directory entries">
      <IuButton
        v-for="entry in listing.entries"
        :key="entry.path"
        size="sm"
        variant="ghost"
        @click="entry.kind === 'directory' ? browse(entry.path) : open(entry.path)"
        >{{ entry.kind === 'directory' ? '▸ ' : '' }}{{ entry.name }}</IuButton
      >
      <p v-if="listing.truncated">Directory listing limited; open a subfolder to see more.</p>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <div class="session-files__tabs" aria-label="Open files">
      <span v-for="d in drafts" :key="d.path">
        <IuButton
          size="sm"
          :variant="selected === d.path ? 'secondary' : 'ghost'"
          :aria-pressed="selected === d.path"
          @click="selected = d.path"
          >{{ d.path }}{{ d.draft !== d.content ? ' •' : '' }}</IuButton
        >
        <IuButton size="sm" variant="ghost" :aria-label="`Close ${d.path}`" @click="close(d)"
          >×</IuButton
        >
      </span>
    </div>
    <template v-for="d in drafts" :key="d.path">
      <div v-show="selected === d.path" class="session-files__document">
        <div class="session-files__toolbar">
          <IuButton size="sm" :disabled="busy || d.draft === d.content || !!d.remote" @click="save"
            >Save</IuButton
          >
          <IuButton size="sm" variant="ghost" @click="refresh">Check disk</IuButton>
          <IuButton
            v-if="/\.md$/i.test(d.path)"
            size="sm"
            variant="ghost"
            :aria-pressed="d.mode === 'source'"
            @click="d.mode = d.mode === 'live' ? 'source' : 'live'"
            >{{ d.mode === 'live' ? 'Source' : 'Live preview' }}</IuButton
          >
          <span role="status">{{ d.draft !== d.content ? 'Unsaved changes' : 'Saved' }}</span>
        </div>
        <div v-if="d.remote" class="session-files__conflict" role="status">
          <p>
            This file changed on disk. Your draft is preserved. Copy your changes before loading the
            disk version.
          </p>
          <IuButton size="sm" @click="useDisk">Load disk version</IuButton>
          <IuDiff :hunks="diffLines(d.remote.content, d.draft)" :filename="d.path" />
        </div>
        <IuCsvViewer
          v-if="/\.(csv|tsv)$/i.test(d.path)"
          :source="d.content"
          :filename="d.path"
          @selection="selectRows(d.path, $event)"
        />
        <IuMarkdownEditor v-else v-model="d.draft" :mode="d.mode" :label="`Edit ${d.path}`" />
      </div>
    </template>
    <p v-if="!drafts.length" class="session-files__hint">
      Open a Markdown, text, CSV or TSV file. Files stay open while you browse.
    </p>
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
.session-files--expanded {
  position: fixed;
  inset: 12px;
  z-index: 80;
  border: 1px solid var(--iu-border);
}
.session-files__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  flex-wrap: wrap;
}
.session-files__location {
  flex: 1;
  overflow-wrap: anywhere;
  color: var(--iu-text-muted);
}
.session-files__listing {
  display: flex;
  flex-wrap: wrap;
  max-height: 160px;
  overflow: auto;
  border-bottom: 1px solid var(--iu-border-quiet);
  padding: 8px;
}
.session-files__tabs {
  display: flex;
  overflow: auto;
  flex: none;
}
.session-files__tabs > span {
  display: flex;
  flex: none;
}
.session-files__document {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  overflow: auto;
}
.session-files__conflict,
.session-files__hint {
  padding: 12px;
}
</style>
