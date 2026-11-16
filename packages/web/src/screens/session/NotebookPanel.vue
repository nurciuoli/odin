<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import type {
  KernelLocation,
  NotebookDataFrame,
  NotebookEnvironment,
  NotebookKernel,
  NotebookOutput as CellOutput,
  NotebookVariable,
} from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuField } from '@/components/Fields'
import { IuSelect } from '@/components/Select'
import { IuBadge } from '@/components/Badge'
import { IuCodeEditor } from '@/components/CodeEditor'
import { statusIntent, statusLabel, type Status } from '@/styles/status'
import NotebookOutput from './NotebookOutput.vue'
import {
  copyCells,
  draftDirty,
  notebookDraft,
  receiveNotebook,
  type NotebookDraft,
} from './notebookDraft'

const props = withDefaults(defineProps<{ session: SessionDetail }>(), {})
const api = useApi()
const kernels = ref<NotebookKernel[]>([])
const attached = ref<string[]>([])
const selected = ref<NotebookKernel[]>([])
const drafts = ref<Record<string, NotebookDraft>>({})
const draft = computed(() => (selected.value[0] ? drafts.value[selected.value[0].id] : undefined))
const dirty = computed(() => (draft.value ? draftDirty(draft.value) : false))
const locked = computed(() => draft.value?.base.editor === 'jupyterlab')
const kernelStatus = computed<Status>(() => {
  const state = draft.value?.base.kernel.state
  return state === 'busy' || state === 'starting'
    ? 'running'
    : state === 'failed'
      ? 'failed'
      : state === 'idle'
        ? 'ok'
        : 'idle'
})
const name = ref('Analysis')
const distro = ref('')
const environment = ref<NotebookEnvironment | null>(null)
const environmentLocation = ref('')
const exportPath = ref('analysis.ipynb')
const message = ref('')
const jupyterUrl = ref('')
const error = ref('')
const busy = ref(false)
const variables = ref<NotebookVariable[]>([])
const frame = ref<NotebookDataFrame | null>(null)
const frameName = ref('')
const frameSort = ref('')
const descending = ref(false)
const liveOutputs = ref<
  Record<string, { execution: string; outputs: CellOutput[]; bytes: number }>
>({})
const location = (): KernelLocation =>
  distro.value.trim() ? { kind: 'wsl', distro: distro.value.trim() } : { kind: 'native' }
function fail(e: unknown) {
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
async function refresh() {
  const [all, linked] = await Promise.all([
    api.listNotebooks(props.session.project),
    api.sessionNotebooks(props.session.id),
  ])
  kernels.value = all
  attached.value = linked.map(k => k.id)
  if (!selected.value.length && linked[0]) await open(linked[0])
}
async function open(kernel: NotebookKernel) {
  const snapshot = await api.getNotebook(kernel.id)
  const existing = drafts.value[kernel.id]
  drafts.value[kernel.id] = existing ? receiveNotebook(existing, snapshot) : notebookDraft(snapshot)
  selected.value = [kernel]
  variables.value = []
  frame.value = null
}
async function select(values: NotebookKernel[]) {
  const kernel = values[0]
  if (kernel) await action(() => open(kernel))
}
async function reloadActive() {
  const current = draft.value
  if (!current) return
  const snapshot = await api.getNotebook(current.base.kernel.id)
  // A selection may change while fetching; update only the requested draft.
  const existing = drafts.value[snapshot.kernel.id]
  if (existing) drafts.value[snapshot.kernel.id] = receiveNotebook(existing, snapshot)
}
async function detect() {
  await action(async () => {
    environment.value = await api.notebookEnvironment(props.session.project, location())
    environmentLocation.value = JSON.stringify(location())
  })
}
async function setup() {
  await action(async () => {
    environment.value = await api.setupNotebookEnvironment(props.session.project, location())
    environmentLocation.value = JSON.stringify(location())
    message.value = 'Notebook environment ready'
  })
}
async function create() {
  await action(async () => {
    if (!environment.value?.interpreter || environmentLocation.value !== JSON.stringify(location()))
      throw new Error('Detect or set up the environment first')
    const kernel = await api.createNotebook(props.session.project, {
      name: name.value,
      interpreter: environment.value.interpreter,
      location: location(),
    })
    await api.attachNotebook(props.session.id, kernel.id)
    await refresh()
    await open(kernel)
  })
}
async function attach() {
  const current = draft.value
  if (current)
    await action(async () => {
      await api.attachNotebook(props.session.id, current.base.kernel.id)
      await refresh()
      message.value = 'Kernel attached'
    })
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
  // Keep edits made while the request was in flight.
  const next = notebookDraft(snapshot)
  if (JSON.stringify(current.cells) !== JSON.stringify(cells)) next.cells = current.cells
  drafts.value[current.base.kernel.id] = next
}
async function save() {
  await action(async () => {
    try {
      await saveActive()
      message.value = 'Notebook saved'
    } catch (e) {
      await reloadActive()
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
      await reloadActive()
    } catch (e) {
      await reloadActive()
      throw e
    }
  })
}
function acceptRemote() {
  const current = draft.value
  if (current?.remote) drafts.value[current.base.kernel.id] = notebookDraft(current.remote)
}
function keepDraft() {
  const current = draft.value
  if (current?.remote) {
    current.base = current.remote
    current.remote = null
  }
}
async function inspect() {
  const current = draft.value
  if (current)
    await action(async () => {
      variables.value = await api.notebookVariables(current.base.kernel.id)
    })
}
async function data(name: string, offset = 0, sort = frameSort.value) {
  const current = draft.value
  if (!current) return
  await action(async () => {
    frame.value = await api.notebookDataFrame(current.base.kernel.id, name, {
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
      await refresh()
      await reloadActive()
    } while (refreshAgain)
  } catch (e) {
    fail(e)
  } finally {
    refreshPending = false
  }
}
onMounted(() => {
  void action(refresh)
  unsubscribe = api.subscribe(
    event => {
      if (event.type === 'notebook.output' && event.kernelId === draft.value?.base.kernel.id) {
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
        event.execution.kernelId === draft.value?.base.kernel.id &&
        ['completed', 'failed', 'interrupted'].includes(event.execution.state)
      ) {
        message.value = `Cell ${event.execution.state}`
        void reloadActive()
          .then(() => {
            delete liveOutputs.value[event.execution.cellId]
          })
          .catch(fail)
      }
      if (
        (event.type === 'notebook.updated' && event.project === props.session.project) ||
        (event.type === 'notebook.execution' &&
          event.execution.kernelId === draft.value?.base.kernel.id)
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
  <section class="notebook-panel" aria-label="Notebook">
    <div class="notebook-panel__toolbar">
      <IuSelect
        :options="kernels"
        :selected="selected"
        aria-label="Notebook kernel"
        placeholder="Choose a kernel"
        @update:selected="select"
      />
      <IuButton size="sm" variant="ghost" :disabled="busy" @click="action(refresh)"
        >Refresh</IuButton
      >
    </div>
    <details class="notebook-panel__create">
      <summary>New kernel</summary>
      <IuField label="Name" :model-value="name" @update:model-value="name = String($event)" />
      <IuField
        label="WSL distro (blank for native)"
        :model-value="distro"
        @update:model-value="distro = String($event)"
      />
      <div class="notebook-panel__toolbar">
        <IuButton size="sm" :disabled="busy" @click="detect">Detect environment</IuButton>
        <IuButton size="sm" :disabled="busy" @click="setup">Set up Python environment</IuButton>
      </div>
      <p v-if="environment">
        {{ environment.kind }} · {{ environment.interpreter || 'No Python environment found'
        }}{{ environment.needsSetup ? ' · Setup required' : '' }}
      </p>
      <IuButton
        :disabled="busy || !name.trim() || !environment?.interpreter || environment.needsSetup"
        @click="create"
        >Create and attach</IuButton
      >
    </details>
    <p v-if="error" role="alert">{{ error }}</p>
    <p aria-live="polite" role="status">{{ message }}</p>
    <template v-if="draft">
      <div class="notebook-panel__context">
        <IuBadge :intent="statusIntent[kernelStatus]" :tempo="kernelStatus"
          >{{ draft.base.kernel.state }} · {{ statusLabel[kernelStatus] }}</IuBadge
        >
        <p><strong>Kernel directory</strong> {{ draft.base.kernel.cwd }}</p>
        <p>
          {{ draft.base.kernel.interpreter }} ·
          {{
            draft.base.kernel.location.kind === 'wsl'
              ? `WSL: ${draft.base.kernel.location.distro}`
              : 'Native'
          }}
        </p>
        <p v-if="draft.base.kernel.cwd !== session.cwd">
          This shared kernel runs in the directory shown above.
        </p>
        <IuButton
          v-if="!attached.includes(draft.base.kernel.id)"
          size="sm"
          :disabled="busy"
          @click="attach"
          >Attach to this session</IuButton
        >
        <p v-if="locked">
          JupyterLab owns this notebook. Return control to Odin before editing or running.
        </p>
        <div class="notebook-panel__toolbar">
          <IuButton
            v-if="!locked"
            size="sm"
            :disabled="busy || dirty"
            @click="
              action(async () => {
                const result = await api.handoffNotebook(draft!.base.kernel.id)
                jupyterUrl = result.url
                await reloadActive()
              })
            "
            >Prepare JupyterLab hand-off</IuButton
          >
          <a v-if="locked && jupyterUrl" :href="jupyterUrl" target="_blank" rel="noopener"
            >Open in JupyterLab</a
          >
          <IuButton
            v-if="locked"
            size="sm"
            :disabled="busy"
            @click="
              action(async () => {
                const snapshot = await api.reclaimNotebook(draft!.base.kernel.id)
                drafts[snapshot.kernel.id] = notebookDraft(snapshot)
                jupyterUrl = ''
              })
            "
            >Return control to Odin</IuButton
          >
        </div>
        <p v-if="draft.base.kernel.error" role="alert">{{ draft.base.kernel.error }}</p>
      </div>
      <div v-if="draft.remote" class="notebook-panel__conflict" role="alert">
        <p>The notebook changed while you were editing. Your draft is preserved.</p>
        <IuButton size="sm" @click="acceptRemote">Load latest and discard draft</IuButton>
        <IuButton size="sm" @click="keepDraft">Keep draft against latest revision</IuButton>
      </div>
      <div class="notebook-panel__toolbar">
        <IuButton size="sm" :disabled="busy || locked" @click="addCell('code')">Add code</IuButton>
        <IuButton size="sm" :disabled="busy || locked" @click="addCell('markdown')"
          >Add markdown</IuButton
        >
        <IuButton size="sm" :disabled="busy || locked || !dirty || !!draft.remote" @click="save"
          >Save{{ dirty ? ' draft' : '' }}</IuButton
        >
        <IuButton
          size="sm"
          :disabled="busy || locked"
          @click="action(() => api.interruptNotebook(draft!.base.kernel.id))"
          >Interrupt</IuButton
        >
        <IuButton
          size="sm"
          :disabled="busy || locked"
          @click="
            action(async () => {
              await api.stopNotebook(draft!.base.kernel.id)
              await reloadActive()
            })
          "
          >Stop kernel</IuButton
        >
      </div>
      <article
        v-for="(cell, cellIndex) in draft.cells"
        :key="cell.id"
        class="notebook-panel__cell"
        :aria-label="`Cell ${cellIndex + 1}`"
      >
        <div class="notebook-panel__toolbar">
          <span
            >{{ cell.kind }} {{ cell.executionCount === null ? '' : `[${cell.executionCount}]` }} ·
            {{ cell.author.kind === 'human' ? 'You' : 'Agent' }}</span
          >
          <IuButton
            v-if="cell.kind === 'code'"
            size="sm"
            :disabled="busy || locked || !!draft.remote"
            @click="run(cell.id)"
            >Run cell</IuButton
          >
          <IuButton
            size="sm"
            variant="ghost"
            :disabled="busy || locked"
            @click="draft.cells.splice(cellIndex, 1)"
            >Remove cell</IuButton
          >
        </div>
        <IuCodeEditor
          v-model="cell.source"
          :label="`Cell ${cellIndex + 1} source`"
          :language="cell.kind === 'code' ? 'python' : 'markdown'"
          :readonly="locked"
          @run="cell.kind === 'code' && run(cell.id)"
        />
        <div class="notebook-panel__outputs">
          <NotebookOutput
            v-for="(output, index) in liveOutputs[cell.id]?.outputs ?? cell.outputs"
            :key="index"
            :output="output"
            :index="index"
            :kernel-id="draft.base.kernel.id"
            :cell-id="cell.id"
          />
        </div>
      </article>
      <div class="notebook-panel__toolbar">
        <IuField
          label="Project notebook path"
          :model-value="exportPath"
          @update:model-value="exportPath = String($event)"
        />
        <IuButton
          size="sm"
          :disabled="busy || dirty"
          @click="
            action(async () => {
              const result = await api.exportNotebook(draft!.base.kernel.id, exportPath)
              message = `Saved to ${result.path}`
            })
          "
          >Save to project</IuButton
        >
      </div>
      <details class="notebook-panel__variables">
        <summary>Variables and dataframes</summary>
        <IuButton size="sm" :disabled="busy || locked" @click="inspect">Inspect variables</IuButton>
        <ul>
          <li v-for="variable in variables" :key="variable.name">
            <strong>{{ variable.name }}</strong> · {{ variable.type }}
            {{ variable.shape?.join(' × ') }} <span>{{ variable.preview }}</span
            ><IuButton
              v-if="variable.type.includes('DataFrame')"
              size="sm"
              :disabled="busy || locked"
              @click="data(variable.name)"
              >View table</IuButton
            >
          </li>
        </ul>
        <template v-if="frame">
          <div class="notebook-panel__table">
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
          <div class="notebook-panel__toolbar">
            <IuButton
              size="sm"
              :disabled="busy || locked || frame.offset === 0"
              @click="data(frameName, Math.max(0, frame.offset - frame.limit))"
              >Previous rows</IuButton
            ><span
              >{{ frame.offset + 1 }}–{{ frame.offset + frame.rows.length }} of
              {{ frame.total }}</span
            ><IuButton
              size="sm"
              :disabled="busy || locked || frame.offset + frame.rows.length >= frame.total"
              @click="data(frameName, frame.offset + frame.limit)"
              >Next rows</IuButton
            >
          </div>
        </template>
      </details>
    </template>
    <p v-else-if="!busy">Choose a kernel or create one to start a notebook.</p>
  </section>
</template>
<style>
.notebook-panel {
  overflow: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-size: var(--iu-font-size-13);
}
.notebook-panel p {
  margin: 4px 0;
  overflow-wrap: anywhere;
}
.notebook-panel__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.notebook-panel__create,
.notebook-panel__context,
.notebook-panel__variables {
  padding: 12px;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-sm);
}
.notebook-panel summary {
  cursor: pointer;
  margin-bottom: 8px;
}
.notebook-panel__cell {
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-sm);
  overflow: hidden;
}
.notebook-panel__cell > .notebook-panel__toolbar {
  padding: 8px;
  background: var(--iu-well);
}
.notebook-panel__outputs {
  padding: 8px;
  display: grid;
  gap: 8px;
}
.notebook-panel__outputs:empty {
  display: none;
}
.notebook-panel__conflict {
  padding: 12px;
  border: 1px solid var(--iu-warning);
}
.notebook-panel__table {
  overflow-x: auto;
}
.notebook-panel table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
}
.notebook-panel th,
.notebook-panel td {
  padding: 8px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.notebook-panel th button {
  color: var(--iu-text);
  background: var(--iu-well);
  border: 1px solid var(--iu-border-quiet);
  font: inherit;
  cursor: pointer;
}
.notebook-panel button:focus-visible,
.notebook-panel summary:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
</style>
