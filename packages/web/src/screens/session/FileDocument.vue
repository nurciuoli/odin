<script setup lang="ts">
// A workspace file on the surface. What it looks like follows from what it is: Markdown is a live document, CSV and
// TSV are a table, a notebook file reads as its cells, and anything else is text. The draft stays here while other
// documents are on show; a change on disk never overwrites it.
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SessionTextFile } from '@odin/shared/api'
import { useApi, ApiRequestError } from '@/api'
import { useDrafts } from '@/app/drafts'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDiff, diffLines } from '@/components/CodeBlock'
import { IuCsvViewer } from '@/components/CsvViewer'
import type { CsvSelection } from '@/components/CsvViewer/csv'
import type { MenuItem } from '@/components/Menu'
import { IuErrorState, IuSkeleton } from '@/components/States'
import DocumentHeader from './DocumentHeader.vue'
import NotebookCell from './NotebookCell.vue'
import { baseName, fileIcon, fileKind, parentPath, parseIpynb } from './documents'
const IuMarkdownEditor = defineAsyncComponent(
  () => import('@/components/MarkdownEditor/MarkdownEditor.vue'),
)

const props = withDefaults(
  defineProps<{
    sessionId: string
    path: string
    /** On show right now; a hidden document does not poll the disk. */
    active?: boolean
    /** Items the surface adds to every document's menu. */
    surfaceMenu?: MenuItem[]
  }>(),
  { active: true, surfaceMenu: () => [] },
)
const emit = defineEmits<{
  close: []
  menu: [id: string]
  'update:dirty': [dirty: boolean]
  /** Start a kernel-backed notebook named after this notebook file. */
  startNotebook: [name: string]
}>()

const api = useApi()
const composerDrafts = useDrafts()
const kind = computed(() => fileKind(props.path))

const file = ref<SessionTextFile | null>(null)
const draft = ref('')
/** The version on disk when it moved under an unsaved draft. */
const remote = ref<SessionTextFile | null>(null)
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref<{ message: string; status: number | null }>({ message: '', status: null })
const error = ref('')
const busy = ref(false)
const mode = ref<'live' | 'source'>('live')
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

const dirty = computed(() => !!file.value && draft.value !== file.value.content)
watch(dirty, value => emit('update:dirty', value))
const cells = computed(() =>
  kind.value === 'notebook' && file.value ? parseIpynb(file.value.content) : null,
)
const readonly = computed(() => kind.value === 'table' || cells.value !== null)

async function load() {
  phase.value = 'loading'
  try {
    const next = await api.readSessionFile(props.sessionId, props.path)
    file.value = next
    draft.value = next.content
    remote.value = null
    phase.value = 'ready'
  } catch (e) {
    loadError.value = {
      message: message(e),
      status: e instanceof ApiRequestError ? e.status : null,
    }
    phase.value = 'error'
  }
}
async function refresh() {
  const current = file.value
  if (!current) return
  try {
    const next = await api.readSessionFile(props.sessionId, props.path)
    if (next.version === current.version) return
    if (dirty.value) remote.value = next
    else {
      file.value = next
      draft.value = next.content
    }
  } catch (e) {
    error.value = message(e)
  }
}
async function save() {
  const current = file.value
  if (!current || busy.value) return
  const content = draft.value
  busy.value = true
  error.value = ''
  try {
    file.value = await api.saveSessionFile(props.sessionId, props.path, content, current.version)
    remote.value = null
  } catch (e) {
    error.value = message(e)
    if (e instanceof ApiRequestError && e.status === 409) await refresh()
  } finally {
    busy.value = false
  }
}
function useDisk() {
  if (remote.value && window.confirm('Discard this draft and load the disk version?')) {
    file.value = remote.value
    draft.value = remote.value.content
    remote.value = null
  }
}
function selectRows(selection: CsvSelection) {
  composerDrafts.append(
    props.sessionId,
    `Selected rows from ${props.path}:\n${JSON.stringify(selection, null, 2)}`,
  )
}

const status = computed(() => {
  if (phase.value === 'loading') return 'Opening'
  if (phase.value === 'error') return 'Could not open'
  if (remote.value) return 'Changed on disk'
  if (busy.value) return 'Saving'
  if (dirty.value) return 'Unsaved changes'
  if (cells.value) return 'Read-only · no kernel'
  return readonly.value ? 'Read-only' : 'Saved'
})
const menu = computed<MenuItem[]>(() => [
  { id: 'check-disk', label: 'Check disk for changes', icon: 'retry', disabled: !file.value },
  ...(kind.value === 'markdown'
    ? [
        {
          id: 'source',
          type: 'check' as const,
          label: 'Show Markdown source',
          checked: mode.value === 'source',
        },
      ]
    : []),
  ...props.surfaceMenu,
])
function onMenu(id: string) {
  if (id === 'check-disk') void refresh()
  else if (id === 'source') mode.value = mode.value === 'live' ? 'source' : 'live'
  else emit('menu', id)
}

// The agent edits files while this one is open: look again whenever the window, or this document, comes back.
const onFocus = () => {
  if (props.active) void refresh()
}
watch(
  () => props.active,
  active => {
    if (active && phase.value === 'ready') void refresh()
  },
)
onMounted(() => {
  void load()
  window.addEventListener('focus', onFocus)
})
onBeforeUnmount(() => window.removeEventListener('focus', onFocus))
defineExpose({ refresh })
</script>

<template>
  <section class="file-doc" :aria-label="path">
    <DocumentHeader
      :name="baseName(path)"
      :dir="parentPath(path)"
      :icon="fileIcon(path)"
      :status="status"
      :menu="menu"
      @select="onMenu"
      @close="emit('close')"
    >
      <template #actions>
        <IuButton
          v-if="cells"
          size="sm"
          variant="secondary"
          @click="emit('startNotebook', baseName(path).replace(/\.ipynb$/i, ''))"
          >Start a kernel</IuButton
        >
        <IuButton
          v-else-if="!readonly && phase === 'ready'"
          size="sm"
          :variant="dirty ? 'primary' : 'ghost'"
          :disabled="busy || !dirty || !!remote"
          @click="save"
          >Save</IuButton
        >
      </template>
    </DocumentHeader>

    <div v-if="phase === 'loading'" class="file-doc__state" aria-busy="true">
      <IuSkeleton shape="text" :rows="6" />
    </div>
    <div v-else-if="phase === 'error'" class="file-doc__state">
      <IuErrorState
        :title="loadError.status === 404 ? 'File not found' : 'Couldn’t open this file'"
        :body="
          loadError.status === 404
            ? 'It may have been moved or deleted since it was listed.'
            : loadError.message
        "
        :trace-id="`GET files/${path} · ${loadError.status ?? 'network'}`"
        @retry="load"
      />
    </div>
    <template v-else-if="file">
      <IuCallout
        v-if="error"
        class="file-doc__notice"
        intent="danger"
        variant="subtle"
        live
        dismissible
        @dismiss="error = ''"
        >{{ error }}</IuCallout
      >
      <div v-if="remote" class="file-doc__conflict" role="status">
        <IuCallout intent="warning" variant="subtle" title="This file changed on disk">
          Your draft is preserved. Copy your changes before loading the disk version.
          <template #actions>
            <IuButton size="sm" @click="useDisk">Load disk version</IuButton>
          </template>
        </IuCallout>
        <IuDiff :hunks="diffLines(remote.content, draft)" :filename="path" />
      </div>
      <div class="file-doc__body" :class="`file-doc__body--${cells ? 'cells' : kind}`">
        <IuCsvViewer
          v-if="kind === 'table'"
          :source="file.content"
          :filename="path"
          @selection="selectRows"
        />
        <template v-else-if="cells">
          <p class="file-doc__hint">
            This is the notebook as saved on disk. Start a kernel to run or edit its cells.
          </p>
          <NotebookCell
            v-for="(cell, index) in cells"
            :key="cell.id"
            :cell="cell"
            :number="index + 1"
            :source="cell.source"
            :outputs="cell.outputs"
            readonly
            detached
          />
          <p v-if="!cells.length" class="file-doc__hint">This notebook has no cells.</p>
        </template>
        <IuMarkdownEditor
          v-else
          v-model="draft"
          :mode="kind === 'markdown' ? mode : 'source'"
          :label="`Edit ${path}`"
        />
      </div>
    </template>
  </section>
</template>

<style>
.file-doc {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.file-doc__state {
  padding: 16px;
}
.file-doc__notice {
  flex: none;
  margin: 12px 16px 0;
}
.file-doc__conflict {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 45%;
  overflow: auto;
  padding: 12px 16px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.file-doc__body {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: auto;
}
.file-doc__body--table {
  padding: 12px 16px;
}
.file-doc__body--cells {
  gap: 16px;
  padding: 16px;
}
.file-doc__hint {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12-5);
}
</style>
