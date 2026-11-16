<script setup lang="ts">
// A notebook on the workspace surface: the file it is (name.ipynb), its cells drawn like the thread draws tool calls,
// and the kernel's chores (details, JupyterLab hand-off, variables, export) behind the header's menu. One kernel per
// document; the draft stays here while other documents are on show.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import type {
  NotebookDataFrame,
  NotebookOutput as CellOutput,
  NotebookVariable,
} from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import type { MenuItem } from '@/components/Menu'
import { IuPropertyList, type PropertyItem } from '@/components/PropertyList'
import { IuErrorState, IuSkeleton } from '@/components/States'
import type { Status } from '@/styles/status'
import DocumentHeader from './DocumentHeader.vue'
import NotebookCell from './NotebookCell.vue'
import { prefersReducedMotion } from './useMediaQuery'
import { notebookFileName } from './documents'
import {
  copyCells,
  draftDirty,
  notebookDraft,
  receiveNotebook,
  type NotebookDraft,
} from './notebookDraft'

const props = withDefaults(
  defineProps<{
    session: SessionDetail
    kernelId: string
    /** Linked to this session already. */
    attached?: boolean
    /** A cell to show: the thread points at it. A new object asks again. */
    reveal?: { cell: string } | null
  }>(),
  { attached: true, reveal: null },
)
const emit = defineEmits<{
  close: []
  /** The kernel was linked to this session, or its details changed. */
  changed: []
  'update:dirty': [dirty: boolean]
}>()

const api = useApi()
const draft = ref<NotebookDraft>()
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const error = ref('')
const message = ref('')
const busy = ref(false)
const tray = ref<'kernel' | 'variables' | null>(null)
const exportPath = ref('')
const jupyterUrl = ref('')
const variables = ref<NotebookVariable[]>([])
const frame = ref<NotebookDataFrame | null>(null)
const frameName = ref('')
const frameSort = ref('')
const descending = ref(false)
const liveOutputs = ref<
  Record<string, { execution: string; outputs: CellOutput[]; bytes: number }>
>({})

const kernel = computed(() => draft.value?.base.kernel)
const dirty = computed(() => (draft.value ? draftDirty(draft.value) : false))
const locked = computed(() => draft.value?.base.editor === 'jupyterlab')
watch(dirty, value => emit('update:dirty', value))

// A cell the thread points at: once the notebook is on the page it scrolls there and marks the cell for a moment.
// Only the scroll and the mark move; focus stays where it is.
const cellsEl = useTemplateRef<HTMLElement>('cells')
const marked = ref('')
let handled: object | null = null
let markTimer: ReturnType<typeof setTimeout> | undefined
async function revealCell() {
  const request = props.reveal
  if (!request || request === handled || !draft.value) return
  handled = request
  await nextTick()
  const cell = [...(cellsEl.value?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])].find(
    el => el.dataset.cell === request.cell,
  )
  if (!cell) return
  if (typeof cell.scrollIntoView === 'function')
    cell.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  marked.value = request.cell
  clearTimeout(markTimer)
  markTimer = setTimeout(() => (marked.value = ''), 2400)
}
watch(() => props.reveal, revealCell)
watch(draft, revealCell)
onBeforeUnmount(() => clearTimeout(markTimer))
const kernelStatus = computed<Status>(() => {
  const state = kernel.value?.state
  return state === 'busy' || state === 'starting'
    ? 'running'
    : state === 'failed'
      ? 'failed'
      : state === 'idle'
        ? 'ok'
        : 'idle'
})
const fileName = computed(() => notebookFileName(kernel.value?.name ?? 'Notebook'))
const kernelWord = computed(() => {
  const state = kernel.value?.state
  return state ? `Kernel ${state}` : ''
})
const status = computed(() => {
  if (phase.value === 'loading') return 'Opening'
  if (busy.value) return 'Working'
  if (draft.value?.remote) return 'Changed elsewhere'
  if (locked.value) return 'In JupyterLab'
  if (dirty.value) return 'Unsaved changes'
  return message.value || kernelWord.value
})
const fail = (e: unknown) => {
  error.value = e instanceof Error ? e.message : String(e)
}
async function action(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    await fn()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = false
  }
}

async function load() {
  phase.value = 'loading'
  try {
    draft.value = notebookDraft(await api.getNotebook(props.kernelId))
    exportPath.value = fileName.value
    phase.value = 'ready'
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
    phase.value = 'error'
  }
}
async function reload() {
  const current = draft.value
  if (!current) return
  const snapshot = await api.getNotebook(current.base.kernel.id)
  // update only the draft that asked
  draft.value = receiveNotebook(current, snapshot)
}
function addCell(kind: 'code' | 'markdown') {
  draft.value?.cells.push({
    id: crypto.randomUUID(),
    kind,
    source: '',
    outputs: [],
    executionCount: null,
    author: { kind: 'human' },
  })
}
async function saveActive() {
  const current = draft.value
  if (!current) return
  const cells = copyCells(current.cells)
  const snapshot = await api.saveNotebook(current.base.kernel.id, current.base.revision, cells)
  // keep edits made while the request was in flight
  const next = notebookDraft(snapshot)
  if (JSON.stringify(current.cells) !== JSON.stringify(cells)) next.cells = current.cells
  draft.value = next
}
async function save() {
  await action(async () => {
    try {
      await saveActive()
      message.value = 'Saved'
    } catch (e) {
      await reload()
      throw e
    }
  })
}
async function run(cellId: string) {
  await action(async () => {
    try {
      if (dirty.value) await saveActive()
      const current = draft.value
      if (!current) return
      const execution = await api.executeNotebook(current.base.kernel.id, {
        cellId,
        revision: current.base.revision,
      })
      message.value = `Cell ${execution.state}`
      await reload()
    } catch (e) {
      await reload()
      throw e
    }
  })
}
function removeCell(index: number) {
  draft.value?.cells.splice(index, 1)
}
function acceptRemote() {
  const current = draft.value
  if (current?.remote) draft.value = notebookDraft(current.remote)
}
function keepDraft() {
  const current = draft.value
  if (current?.remote) {
    current.base = current.remote
    current.remote = null
  }
}
async function attach() {
  await action(async () => {
    await api.attachNotebook(props.session.id, props.kernelId)
    emit('changed')
    message.value = 'Attached to this session'
  })
}
async function handoff() {
  await action(async () => {
    const result = await api.handoffNotebook(props.kernelId)
    jupyterUrl.value = result.url
    await reload()
  })
}
async function reclaim() {
  await action(async () => {
    draft.value = notebookDraft(await api.reclaimNotebook(props.kernelId))
    jupyterUrl.value = ''
  })
}
async function exportToProject() {
  await action(async () => {
    const result = await api.exportNotebook(props.kernelId, exportPath.value)
    message.value = `Saved to ${result.path}`
  })
}
async function inspect() {
  tray.value = 'variables'
  await action(async () => {
    variables.value = await api.notebookVariables(props.kernelId)
  })
}
async function data(name: string, offset = 0, sort = frameSort.value) {
  await action(async () => {
    frame.value = await api.notebookDataFrame(props.kernelId, name, {
      offset,
      limit: 50,
      sort: sort || undefined,
      descending: descending.value,
    })
    frameName.value = name
    frameSort.value = sort
  })
}
async function sortColumn(column: string) {
  descending.value = frameSort.value === column ? !descending.value : false
  await data(frameName.value, 0, column)
}

const menu = computed<MenuItem[]>(() => [
  {
    id: 'kernel',
    type: 'check',
    label: 'Kernel details',
    checked: tray.value === 'kernel',
  },
  { id: 'variables', label: 'Inspect variables', disabled: busy.value || locked.value },
  { type: 'separator' },
  { id: 'code', label: 'Add code cell', icon: 'plus', disabled: busy.value || locked.value },
  {
    id: 'markdown',
    label: 'Add Markdown cell',
    icon: 'plus',
    disabled: busy.value || locked.value,
  },
  { type: 'separator' },
  {
    id: 'interrupt',
    label: 'Interrupt kernel',
    icon: 'pause',
    disabled: busy.value || locked.value,
  },
  { id: 'stop', label: 'Stop kernel', icon: 'stop', disabled: busy.value || locked.value },
  { type: 'separator' },
  locked.value
    ? { id: 'reclaim', label: 'Return control to Odin', disabled: busy.value }
    : { id: 'handoff', label: 'Prepare JupyterLab hand-off', disabled: busy.value || dirty.value },
])
async function onMenu(id: string) {
  if (id === 'kernel') tray.value = tray.value === 'kernel' ? null : 'kernel'
  else if (id === 'variables') await inspect()
  else if (id === 'code' || id === 'markdown') addCell(id)
  else if (id === 'interrupt') await action(() => api.interruptNotebook(props.kernelId))
  else if (id === 'stop')
    await action(async () => {
      await api.stopNotebook(props.kernelId)
      await reload()
    })
  else if (id === 'handoff') await handoff()
  else if (id === 'reclaim') await reclaim()
}

const details = computed<PropertyItem[]>(() => {
  const k = kernel.value
  if (!k) return []
  return [
    { label: 'Directory', value: k.cwd, mono: true },
    { label: 'Interpreter', value: k.interpreter, mono: true },
    {
      label: 'Runs',
      value: k.location.kind === 'wsl' ? `WSL: ${k.location.distro}` : 'Native',
    },
  ]
})

let unsubscribe: (() => void) | undefined
let refreshPending = false
let refreshAgain = false
async function refreshFromEvent() {
  if (refreshPending) {
    refreshAgain = true
    return
  }
  refreshPending = true
  try {
    do {
      refreshAgain = false
      await reload()
    } while (refreshAgain)
  } catch (e) {
    fail(e)
  } finally {
    refreshPending = false
  }
}
onMounted(() => {
  void load()
  unsubscribe = api.subscribe(
    event => {
      if (event.type === 'notebook.output' && event.kernelId === props.kernelId) {
        const current = liveOutputs.value[event.cellId]
        const live =
          current?.execution === event.executionId
            ? current
            : { execution: event.executionId, outputs: [], bytes: 0 }
        const bytes = JSON.stringify(event.output).length
        if (live.outputs.length < 100 && live.bytes + bytes < 4 * 1024 * 1024) {
          live.outputs.push(event.output)
          live.bytes += bytes
        }
        liveOutputs.value[event.cellId] = live
      }
      if (
        event.type === 'notebook.execution' &&
        event.execution.kernelId === props.kernelId &&
        ['completed', 'failed', 'interrupted'].includes(event.execution.state)
      ) {
        message.value = `Cell ${event.execution.state}`
        void reload()
          .then(() => {
            delete liveOutputs.value[event.execution.cellId]
          })
          .catch(fail)
      }
      if (
        (event.type === 'notebook.updated' && event.kernelId === props.kernelId) ||
        (event.type === 'notebook.execution' && event.execution.kernelId === props.kernelId)
      )
        void refreshFromEvent()
    },
    () => {
      void refreshFromEvent()
    },
  )
})
onBeforeUnmount(() => unsubscribe?.())
</script>

<template>
  <section class="nb-doc" :aria-label="fileName">
    <DocumentHeader
      :name="fileName"
      icon="terminal"
      :status="status"
      :tone="phase === 'ready' && !dirty && !busy ? kernelStatus : null"
      :menu="menu"
      @select="onMenu"
      @close="emit('close')"
    >
      <template #actions>
        <IuButton
          v-if="phase === 'ready' && !attached"
          size="sm"
          variant="secondary"
          :disabled="busy"
          @click="attach"
          >Attach</IuButton
        >
        <IuButton
          v-if="phase === 'ready' && (dirty || draft?.remote)"
          size="sm"
          variant="primary"
          :disabled="busy || locked || !!draft?.remote"
          @click="save"
          >Save</IuButton
        >
      </template>
    </DocumentHeader>

    <div v-if="phase === 'loading'" class="nb-doc__state" aria-busy="true">
      <IuSkeleton shape="text" :rows="6" />
    </div>
    <div v-else-if="phase === 'error'" class="nb-doc__state">
      <IuErrorState
        title="Couldn’t open this notebook"
        :body="loadError"
        :trace-id="`GET notebooks/${kernelId}`"
        @retry="load"
      />
    </div>
    <template v-else-if="draft && kernel">
      <div class="nb-doc__notices">
        <IuCallout
          v-if="error"
          intent="danger"
          variant="subtle"
          live
          dismissible
          @dismiss="error = ''"
          >{{ error }}</IuCallout
        >
        <IuCallout v-if="kernel.error" intent="danger" variant="subtle" live>{{
          kernel.error
        }}</IuCallout>
        <IuCallout
          v-if="locked"
          intent="warning"
          variant="subtle"
          title="JupyterLab owns this notebook"
        >
          Return control to Odin before editing or running.
          <template #actions>
            <a v-if="jupyterUrl" :href="jupyterUrl" target="_blank" rel="noopener"
              >Open in JupyterLab</a
            >
            <IuButton size="sm" :disabled="busy" @click="reclaim">Return control to Odin</IuButton>
          </template>
        </IuCallout>
        <IuCallout
          v-if="draft.remote"
          intent="warning"
          variant="subtle"
          live
          title="Changed while you were editing"
        >
          Your draft is preserved.
          <template #actions>
            <IuButton size="sm" @click="acceptRemote">Load latest and discard draft</IuButton>
            <IuButton size="sm" @click="keepDraft">Keep draft against latest revision</IuButton>
          </template>
        </IuCallout>
        <IuCallout v-if="!attached" intent="info" variant="subtle">
          This kernel is not attached to this session. Attach it to let the agent use it.
        </IuCallout>
        <IuCallout v-if="kernel.cwd !== session.cwd" intent="info" variant="subtle">
          This shared kernel runs in {{ kernel.cwd }}, not this session’s directory.
        </IuCallout>
      </div>

      <div v-if="tray === 'kernel'" class="nb-doc__tray">
        <IuPropertyList :items="details" density="compact" label-width="96px" />
        <div class="nb-doc__export">
          <IuField
            label="Project notebook path"
            size="sm"
            :model-value="exportPath"
            @update:model-value="exportPath = String($event)"
          />
          <IuButton size="sm" :disabled="busy || dirty" @click="exportToProject"
            >Save to project</IuButton
          >
        </div>
      </div>
      <div v-if="tray === 'variables'" class="nb-doc__tray">
        <p v-if="!variables.length" class="nb-doc__hint">No variables in this kernel yet.</p>
        <ul v-else class="nb-doc__vars">
          <li v-for="variable in variables" :key="variable.name">
            <span class="nb-doc__var">{{ variable.name }}</span>
            <span class="nb-doc__hint"
              >{{ variable.type }} {{ variable.shape?.join(' × ') }} · {{ variable.preview }}</span
            >
            <IuButton
              v-if="variable.type.includes('DataFrame')"
              size="sm"
              variant="ghost"
              :disabled="busy || locked"
              @click="data(variable.name)"
              >View table</IuButton
            >
          </li>
        </ul>
        <template v-if="frame">
          <div class="nb-doc__table">
            <table>
              <thead>
                <tr>
                  <th
                    v-for="column in frame.columns"
                    :key="column.name"
                    :aria-sort="
                      frameSort === column.name ? (descending ? 'descending' : 'ascending') : 'none'
                    "
                  >
                    <button
                      type="button"
                      :disabled="busy || locked"
                      @click="sortColumn(column.name)"
                    >
                      {{ column.name }} · {{ column.type }}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, index) in frame.rows" :key="index">
                  <td v-for="(value, column) in row" :key="column">{{ value }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="nb-doc__pager">
            <IuButton
              size="sm"
              variant="ghost"
              :disabled="busy || locked || frame.offset === 0"
              @click="data(frameName, Math.max(0, frame.offset - frame.limit))"
              >Previous rows</IuButton
            >
            <span class="nb-doc__hint"
              >{{ frame.offset + 1 }}–{{ frame.offset + frame.rows.length }} of
              {{ frame.total }}</span
            >
            <IuButton
              size="sm"
              variant="ghost"
              :disabled="busy || locked || frame.offset + frame.rows.length >= frame.total"
              @click="data(frameName, frame.offset + frame.limit)"
              >Next rows</IuButton
            >
          </div>
        </template>
      </div>

      <div ref="cells" class="nb-doc__cells">
        <NotebookCell
          v-for="(cell, index) in draft.cells"
          :key="cell.id"
          v-model:source="cell.source"
          :cell="cell"
          :number="index + 1"
          :outputs="liveOutputs[cell.id]?.outputs ?? cell.outputs"
          :kernel-id="kernel.id"
          :readonly="locked"
          :blocked="busy || locked || !!draft.remote"
          :locked="busy || locked"
          :marked="marked === cell.id"
          @run="run(cell.id)"
          @remove="removeCell(index)"
        />
        <p v-if="!draft.cells.length" class="nb-doc__hint">This notebook has no cells yet.</p>
        <div class="nb-doc__add">
          <IuButton size="sm" variant="ghost" :disabled="busy || locked" @click="addCell('code')">
            <template #icon><IuIcon name="plus" :size="14" /></template>
            Code
          </IuButton>
          <IuButton
            size="sm"
            variant="ghost"
            :disabled="busy || locked"
            @click="addCell('markdown')"
          >
            <template #icon><IuIcon name="plus" :size="14" /></template>
            Markdown
          </IuButton>
        </div>
      </div>
    </template>
  </section>
</template>

<style>
.nb-doc {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.nb-doc__state {
  padding: 16px;
}
.nb-doc__notices {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px 0;
}
.nb-doc__notices:empty {
  display: none;
}
.nb-doc__tray {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-height: 50%;
  overflow: auto;
  margin: 12px 16px 0;
  padding: 12px;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-md);
  background: var(--iu-well);
}
.nb-doc__export {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.nb-doc__export > :first-child {
  flex: 1;
  min-width: 0;
}
.nb-doc__cells {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: auto;
  padding: 16px;
}
.nb-doc__hint {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12-5);
  overflow-wrap: anywhere;
}
.nb-doc__add {
  display: flex;
  gap: 4px;
}
.nb-doc__vars {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.nb-doc__vars li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.nb-doc__var {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
}
.nb-doc__table {
  overflow-x: auto;
}
.nb-doc__table table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: var(--iu-font-size-12-5);
}
.nb-doc__table th,
.nb-doc__table td {
  padding: 6px 8px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.nb-doc__table th button {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--iu-text);
  font: inherit;
  font-weight: var(--iu-font-weight-medium);
  cursor: pointer;
}
.nb-doc__table th button:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.nb-doc__pager {
  display: flex;
  align-items: center;
  gap: 8px;
}
</style>
