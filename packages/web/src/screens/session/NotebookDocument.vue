<script setup lang="ts">
// A notebook on the workspace surface: the file it is (name.ipynb), its cells drawn as a quiet document, and the
// kernel's chores behind the kernel chip. The Python environment is detected silently when the notebook opens; the
// chip says which interpreter runs the cells, or "Select kernel" when there is none. Run, Restart and the rest sit in
// a toolbar that folds what does not fit into a menu; a wide pane also gets an outline. One kernel per document; the
// draft stays here while other documents are on show.
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  toRaw,
  useTemplateRef,
  watch,
} from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import type {
  KernelLocation,
  NotebookDataFrame,
  NotebookEnvironment,
  NotebookExecution,
  NotebookOutput as CellOutput,
  NotebookVariable,
} from '@odin/shared/notebooks'
import { ApiRequestError, useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuErrorState, IuSkeleton } from '@/components/States'
import { IuStatusDot } from '@/components/StatusDot'
import { statusLabel, type Status } from '@/styles/status'
import DocumentHeader from './DocumentHeader.vue'
import NotebookCell from './NotebookCell.vue'
import { prefersReducedMotion } from './useMediaQuery'
import {
  copyCells,
  draftDirty,
  notebookDraft,
  receiveNotebook,
  type NotebookDraft,
} from './notebookDraft'
import {
  formatDuration,
  outlineEntries,
  showOutline,
  visibleToolbarCount,
  type CellStatus,
} from './notebookLayout'

const props = withDefaults(
  defineProps<{
    session: SessionDetail
    kernelId: string
    /** A cell to show: the thread points at it. A new object asks again. */
    reveal?: { cell: string } | null
  }>(),
  { reveal: null },
)
const emit = defineEmits<{
  close: []
  /** The chip's menu sends the user to the panel's Environment tab. */
  'open-environment': []
  'update:dirty': [dirty: boolean]
}>()

const api = useApi()
const draft = ref<NotebookDraft>()
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const error = ref('')
const message = ref('')
const busy = ref(false)
const tray = ref<'variables' | null>(null)
/** A run was refused for want of Python. */
const noEnvironment = ref(false)
/** What detection found, for the kernel menu. Nothing is shown for it until the menu is opened. */
const detected = ref<NotebookEnvironment | null>(null)
const variables = ref<NotebookVariable[]>([])
const frame = ref<NotebookDataFrame | null>(null)
const frameName = ref('')
const frameSort = ref('')
const descending = ref(false)
const liveOutputs = ref<
  Record<string, { execution: string; outputs: CellOutput[]; bytes: number }>
>({})
/** Per cell: running now, the last run's time and result, and why a run failed (shown on the cell). */
const running = reactive<Record<string, true>>({})
const runInfo = reactive<Record<string, { state: string; duration: string }>>({})
const cellErrors = reactive<Record<string, string>>({})

const kernel = computed(() => draft.value?.base.kernel)
const dirty = computed(() => (draft.value ? draftDirty(draft.value) : false))
const needsEnvironment = computed(
  () => !!kernel.value && (noEnvironment.value || !kernel.value.interpreter),
)
watch(dirty, value => emit('update:dirty', value))

// ---- the pane's width: the toolbar folds and the outline shows by it, not by the window's.
const root = useTemplateRef<HTMLElement>('root')
const toolbarEl = useTemplateRef<HTMLElement>('toolbar')
const measureEl = useTemplateRef<HTMLElement>('measure')
const paneWidth = ref(0)
const toolbarWidth = ref(Infinity)
const widths = ref<number[]>([])
const menuWidth = ref(0)
const outlineOn = computed(() => showOutline(paneWidth.value))
let resize: ResizeObserver | undefined
function measure() {
  const row = measureEl.value
  if (!row) return
  const buttons = [...row.querySelectorAll<HTMLElement>('[data-tool]')]
  widths.value = buttons.map(b => b.offsetWidth)
  menuWidth.value = row.querySelector<HTMLElement>('[data-tool-menu]')?.offsetWidth ?? 0
}
function observe() {
  if (typeof ResizeObserver === 'undefined') return
  resize = new ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target === root.value) paneWidth.value = entry.contentRect.width
      if (entry.target === toolbarEl.value) toolbarWidth.value = entry.contentRect.width
    }
  })
  if (root.value) resize.observe(root.value)
  if (toolbarEl.value) resize.observe(toolbarEl.value)
}
watch(toolbarEl, el => {
  if (el && resize) resize.observe(el)
})
watch(measureEl, el => {
  if (el) void nextTick(measure)
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

// ---- cells: status, outline, reveal
const codeCells = computed(() => draft.value?.cells.filter(c => c.kind === 'code') ?? [])
function cellStatus(id: string): CellStatus {
  const cell = draft.value?.cells.find(c => c.id === id)
  if (running[id]) return 'running'
  if (cellErrors[id] || cell?.outputs.some(o => o.type === 'error')) return 'failed'
  if (runInfo[id]?.state === 'failed') return 'failed'
  return cell && cell.executionCount !== null ? 'ok' : 'idle'
}
const outline = computed(() => outlineEntries(draft.value?.cells ?? []))
const firstCodeId = computed(() => codeCells.value[0]?.id)

const cellsEl = useTemplateRef<HTMLElement>('cells')
const marked = ref('')
const activeCell = ref('')
const scrollBehavior = () => (prefersReducedMotion() ? 'auto' : 'smooth')
const cellElement = (id: string) =>
  [...(cellsEl.value?.querySelectorAll<HTMLElement>('[data-cell]') ?? [])].find(
    el => el.dataset.cell === id,
  )
// The cell at the top of the view is the current one.
function trackActive() {
  const box = cellsEl.value
  if (!box) return
  const top = box.getBoundingClientRect().top + 48
  let current = ''
  for (const el of box.querySelectorAll<HTMLElement>('[data-cell]')) {
    if (el.getBoundingClientRect().top <= top) current = el.dataset.cell ?? current
    else break
  }
  activeCell.value = current || (draft.value?.cells[0]?.id ?? '')
}
// A click on the outline: scroll there and focus the cell. Only ever called from a user's click.
function goToCell(id: string) {
  const el = cellElement(id)
  if (!el) return
  if (typeof el.scrollIntoView === 'function')
    el.scrollIntoView({ block: 'start', behavior: scrollBehavior() })
  el.focus({ preventScroll: true })
  activeCell.value = id
}

// A cell the thread points at: once the notebook is on the page it scrolls there and marks the cell for a moment.
// Only the scroll and the mark move; focus stays where it is.
let handled: object | null = null
let markTimer: ReturnType<typeof setTimeout> | undefined
async function revealCell() {
  const request = props.reveal
  if (!request || request === handled || !draft.value) return
  handled = request
  await nextTick()
  const cell = cellElement(request.cell)
  if (!cell) return
  if (typeof cell.scrollIntoView === 'function')
    cell.scrollIntoView({ block: 'center', behavior: scrollBehavior() })
  marked.value = request.cell
  clearTimeout(markTimer)
  markTimer = setTimeout(() => (marked.value = ''), 2400)
}
watch(() => props.reveal, revealCell)
watch(draft, revealCell)
onBeforeUnmount(() => clearTimeout(markTimer))

// ---- the kernel chip
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
const fileName = computed(() => kernel.value?.name ?? 'Notebook')
/** ".venv/bin/python" is "Python (.venv)": the environment's folder, not the file. */
function interpreterName(path: string | null | undefined): string {
  if (!path) return ''
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const env = parts.filter(
    (p, i) =>
      !(i === parts.length - 1 && /^python[\d.]*(\.exe)?$/i.test(p)) && !/^(bin|Scripts)$/.test(p),
  )
  const last = env[env.length - 1]
  return last ? `Python (${last})` : 'Python'
}
const chipLabel = computed(() =>
  needsEnvironment.value ? 'Select kernel' : interpreterName(kernel.value?.interpreter),
)
const chipTitle = computed(() =>
  needsEnvironment.value
    ? 'No Python environment: choose how this notebook runs'
    : `${chipLabel.value}, kernel ${kernel.value?.state ?? ''}`,
)
const chipDot = computed<Status>(() => (needsEnvironment.value ? 'idle' : kernelStatus.value))
const location = (): KernelLocation => {
  const at = kernel.value?.location
  return at ? { ...toRaw(at) } : { kind: 'native' }
}

const kernelMenu = computed<MenuItem[]>(() => {
  const k = kernel.value
  const items: MenuItem[] = [{ type: 'label', label: 'Python environment' }]
  if (k?.interpreter && !noEnvironment.value)
    items.push({
      id: 'env:current',
      type: 'check',
      checked: true,
      label: interpreterName(k.interpreter),
      description: k.interpreter,
    })
  else items.push({ type: 'label', label: 'No Python found' })
  const found = detected.value
  if (found?.interpreter && !found.needsSetup && found.interpreter !== k?.interpreter)
    items.push({
      id: 'env:use',
      label: `Use ${interpreterName(found.interpreter)}`,
      description: found.interpreter,
      disabled: busy.value,
    })
  items.push({ id: 'env:setup', label: 'Set up Python environment…' })
  items.push(
    { type: 'separator' },
    { id: 'interrupt', label: 'Interrupt kernel', icon: 'pause', disabled: busy.value },
    { id: 'restart', label: 'Restart kernel', icon: 'retry', disabled: busy.value },
    { id: 'stop', label: 'Stop kernel', icon: 'stop', disabled: busy.value },
    { type: 'separator' },
    { id: 'variables', label: 'Variables', disabled: busy.value },
    { id: 'kernel', label: 'Kernel details…' },
  )
  return items
})

// ---- loading and the silent environment check
async function load() {
  phase.value = 'loading'
  try {
    draft.value = notebookDraft(await api.getNotebook(props.kernelId))
    phase.value = 'ready'
    void detect()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
    phase.value = 'error'
  }
}
/** Looks for Python when the notebook opens; if the notebook has none and one is found, it takes it. No banner. */
async function detect(at: KernelLocation = location(), adopt = true) {
  const k = kernel.value
  if (!k) return
  try {
    const found = await api.notebookEnvironment(props.session.project, at)
    detected.value = found
    if (adopt && !k.interpreter && found.interpreter && !found.needsSetup)
      await configure({ interpreter: found.interpreter, location: at }, false)
  } catch {
    // Detection is a convenience: without it the chip says "Select kernel" and the menu still works.
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
function recordRun(execution: NotebookExecution) {
  const { startedAt, finishedAt } = execution
  runInfo[execution.cellId] = {
    state: execution.state,
    duration:
      startedAt && finishedAt ? formatDuration(Date.parse(finishedAt) - Date.parse(startedAt)) : '',
  }
  if (execution.state === 'failed') cellErrors[execution.cellId] = execution.error ?? ''
}
/** Runs one cell; a failure is said on that cell. Returns whether the run completed. */
async function runOne(cellId: string): Promise<boolean> {
  delete cellErrors[cellId]
  running[cellId] = true
  try {
    if (dirty.value) await saveActive()
    const current = draft.value
    if (!current) return false
    const execution = await api.executeNotebook(current.base.kernel.id, {
      cellId,
      revision: current.base.revision,
    })
    recordRun(execution)
    message.value = `Cell ${execution.state}`
    await reload()
    return execution.state === 'completed'
  } catch (e) {
    await reload().catch(() => {})
    // A refusal for want of Python is the chip's business, not an error to read.
    if (e instanceof ApiRequestError && e.status === 409 && /environment/i.test(e.message)) {
      noEnvironment.value = true
      return false
    }
    cellErrors[cellId] = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    delete running[cellId]
  }
}
const run = (cellId: string) => action(async () => void (await runOne(cellId)))
const runAll = () =>
  action(async () => {
    for (const cell of [...codeCells.value]) if (!(await runOne(cell.id))) return
  })
const clearOutputs = () => {
  for (const cell of draft.value?.cells ?? []) {
    cell.outputs = []
    cell.executionCount = null
  }
  for (const id of Object.keys(runInfo)) delete runInfo[id]
  for (const id of Object.keys(cellErrors)) delete cellErrors[id]
}
const restart = () =>
  action(async () => {
    // The kernel starts again, lazily, on the next run.
    await api.stopNotebook(props.kernelId)
    await reload()
    message.value = 'Kernel restarted'
  })
const interrupt = () => action(() => api.interruptNotebook(props.kernelId))
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
async function configure(
  environment: { interpreter: string; location: KernelLocation },
  announce = true,
) {
  const k = draft.value?.base.kernel
  if (!k) return
  await api.openNotebook(props.session.project, { path: k.path, ...environment })
  noEnvironment.value = false
  await reload()
  if (announce) message.value = 'Python environment set'
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

// ---- toolbar: buttons in priority order; what does not fit folds into the menu
interface Tool {
  id: string
  label: string
  icon: 'play' | 'retry' | 'backspace' | 'pause' | 'database'
  disabled: boolean
}
const tools = computed<Tool[]>(() => [
  {
    id: 'run-all',
    label: 'Run all',
    icon: 'play',
    disabled: busy.value || !!draft.value?.remote || !codeCells.value.length,
  },
  { id: 'restart', label: 'Restart', icon: 'retry', disabled: busy.value },
  {
    id: 'clear',
    label: 'Clear outputs',
    icon: 'backspace',
    disabled:
      busy.value || !draft.value?.cells.some(c => c.outputs.length || c.executionCount !== null),
  },
  { id: 'interrupt', label: 'Interrupt', icon: 'pause', disabled: busy.value },
  { id: 'variables', label: 'Variables', icon: 'database', disabled: busy.value },
])
const shown = computed(() =>
  visibleToolbarCount(toolbarWidth.value, widths.value, 4, menuWidth.value),
)
const visibleTools = computed(() => tools.value.slice(0, shown.value))
const foldedTools = computed<MenuItem[]>(() =>
  tools.value
    .slice(shown.value)
    .map(t => ({ id: t.id, label: t.label, icon: t.icon, disabled: t.disabled })),
)
async function onTool(id: string) {
  if (id === 'run-all') await runAll()
  else if (id === 'restart') await restart()
  else if (id === 'clear') clearOutputs()
  else if (id === 'interrupt') await interrupt()
  else if (id === 'variables') await inspect()
}
watch(
  () => tools.value.map(t => t.label).join(),
  () => void nextTick(measure),
)

const menu = computed<MenuItem[]>(() => [
  { id: 'code', label: 'Add code cell', icon: 'plus', disabled: busy.value },
  { id: 'markdown', label: 'Add Markdown cell', icon: 'plus', disabled: busy.value },
])
function onMenu(id: string) {
  if (id === 'code' || id === 'markdown') addCell(id)
}
async function onKernelMenu(id: string) {
  if (id === 'kernel' || id === 'env:setup') emit('open-environment')
  else if (id === 'variables') await inspect()
  else if (id === 'interrupt') await interrupt()
  else if (id === 'restart') await restart()
  else if (id === 'stop')
    await action(async () => {
      await api.stopNotebook(props.kernelId)
      await reload()
    })
  else if (id === 'env:use' && detected.value?.interpreter)
    await action(() =>
      configure({ interpreter: detected.value!.interpreter!, location: location() }),
    )
}

const status = computed(() => {
  if (phase.value === 'loading') return 'Opening'
  if (busy.value) return 'Working'
  if (draft.value?.remote) return 'Changed elsewhere'
  if (dirty.value) return 'Unsaved changes'
  return message.value
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
  observe()
  void nextTick(measure)
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
      if (event.type === 'notebook.execution' && event.execution.kernelId === props.kernelId) {
        const { state, cellId } = event.execution
        if (state === 'queued' || state === 'running') running[cellId] = true
        else {
          delete running[cellId]
          recordRun(event.execution)
          message.value = `Cell ${state}`
          void reload()
            .then(() => {
              delete liveOutputs.value[cellId]
            })
            .catch(fail)
        }
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
onBeforeUnmount(() => {
  unsubscribe?.()
  resize?.disconnect()
})
</script>

<template>
  <section ref="root" class="nb-doc" :aria-label="fileName">
    <DocumentHeader
      :name="fileName"
      icon="terminal"
      :status="status"
      :menu="menu"
      @select="onMenu"
      @close="emit('close')"
    >
      <template #actions>
        <IuMenu v-if="phase === 'ready' && kernel" :items="kernelMenu" @select="onKernelMenu">
          <template #trigger="{ toggle, open }">
            <IuButton
              class="nb-chip"
              :class="{ 'nb-chip--none': needsEnvironment }"
              size="sm"
              variant="secondary"
              aria-haspopup="menu"
              :aria-expanded="open"
              :aria-label="chipTitle"
              :title="chipTitle"
              @click="toggle"
            >
              <template #icon>
                <IuStatusDot :status="chipDot" :size="8" decorative />
              </template>
              <span class="nb-chip__label">{{ chipLabel }}</span>
              <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
            </IuButton>
          </template>
        </IuMenu>
        <IuButton
          v-if="phase === 'ready' && (dirty || draft?.remote)"
          size="sm"
          variant="primary"
          :disabled="busy || !!draft?.remote"
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
      <div ref="toolbar" class="nb-doc__toolbar" role="toolbar" aria-label="Notebook actions">
        <IuButton
          v-for="tool in visibleTools"
          :key="tool.id"
          size="sm"
          variant="ghost"
          :disabled="tool.disabled"
          @click="onTool(tool.id)"
        >
          <template #icon><IuIcon :name="tool.icon" :size="14" /></template>
          {{ tool.label }}
        </IuButton>
        <IuMenu v-if="foldedTools.length" :items="foldedTools" @select="onTool">
          <template #trigger="{ toggle, open }">
            <IuButton
              size="sm"
              variant="ghost"
              icon-only
              aria-label="More notebook actions"
              aria-haspopup="menu"
              :aria-expanded="open"
              @click="toggle"
            >
              <template #icon><IuIcon name="more" :size="14" /></template>
            </IuButton>
          </template>
        </IuMenu>
      </div>
      <!-- the same buttons, unseen, so their widths can be read -->
      <div ref="measure" class="nb-doc__measure" aria-hidden="true" inert>
        <IuButton v-for="tool in tools" :key="tool.id" data-tool size="sm" variant="ghost">
          <template #icon><IuIcon :name="tool.icon" :size="14" /></template>
          {{ tool.label }}
        </IuButton>
        <IuButton data-tool-menu size="sm" variant="ghost" icon-only tabindex="-1">
          <template #icon><IuIcon name="more" :size="14" /></template>
        </IuButton>
      </div>

      <div v-if="error || kernel.error" class="nb-doc__lines">
        <p v-if="kernel.error" class="nb-doc__line nb-doc__line--danger" role="alert">
          {{ kernel.error }}
        </p>
        <p v-if="error" class="nb-doc__line nb-doc__line--danger" role="alert">
          {{ error }}
          <button type="button" class="nb-doc__dismiss" @click="error = ''">Dismiss</button>
        </p>
      </div>
      <div v-if="draft.remote" class="nb-doc__notices">
        <IuCallout intent="warning" variant="subtle" live title="Changed while you were editing">
          Your draft is preserved.
          <template #actions>
            <IuButton size="sm" @click="acceptRemote">Load latest and discard draft</IuButton>
            <IuButton size="sm" @click="keepDraft">Keep draft against latest revision</IuButton>
          </template>
        </IuCallout>
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
              :disabled="busy"
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
                    <button type="button" :disabled="busy" @click="sortColumn(column.name)">
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
              :disabled="busy || frame.offset === 0"
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
              :disabled="busy || frame.offset + frame.rows.length >= frame.total"
              @click="data(frameName, frame.offset + frame.limit)"
              >Next rows</IuButton
            >
          </div>
        </template>
      </div>

      <div class="nb-doc__main" :class="{ 'nb-doc__main--outline': outlineOn }">
        <nav v-if="outlineOn" class="nb-doc__outline" aria-label="Notebook outline">
          <p v-if="!outline.length" class="nb-doc__hint">Nothing to outline yet.</p>
          <button
            v-for="entry in outline"
            :key="entry.key"
            type="button"
            class="nb-doc__outline-item"
            :class="[
              entry.kind === 'heading' ? 'nb-doc__outline-item--heading' : '',
              entry.level > 1 ? 'nb-doc__outline-item--sub' : '',
            ]"
            :aria-current="activeCell === entry.cellId ? 'location' : undefined"
            @click="goToCell(entry.cellId)"
          >
            <IuStatusDot
              v-if="entry.kind === 'cell'"
              :status="cellStatus(entry.cellId)"
              :size="7"
              :label="`Cell ${entry.number}: ${statusLabel[cellStatus(entry.cellId)]}`"
            />
            <span class="nb-doc__outline-text">{{ entry.text }}</span>
          </button>
        </nav>
        <div ref="cells" class="nb-doc__cells" @scroll.passive="trackActive">
          <NotebookCell
            v-for="(cell, index) in draft.cells"
            :key="cell.id"
            v-model:source="cell.source"
            :cell="cell"
            :number="index + 1"
            :outputs="liveOutputs[cell.id]?.outputs ?? cell.outputs"
            :kernel-id="kernel.id"
            :blocked="busy || !!draft.remote"
            :locked="busy"
            :marked="marked === cell.id"
            :status="cellStatus(cell.id)"
            :duration="runInfo[cell.id]?.duration"
            :error="cellErrors[cell.id]"
            :note="
              needsEnvironment && cell.id === firstCodeId
                ? 'No Python found. Choose a kernel above to run cells.'
                : ''
            "
            @run="run(cell.id)"
            @remove="removeCell(index)"
          />
          <p v-if="!draft.cells.length" class="nb-doc__hint">This notebook has no cells yet.</p>
          <div class="nb-doc__add">
            <IuButton size="sm" variant="ghost" :disabled="busy" @click="addCell('code')">
              <template #icon><IuIcon name="plus" :size="14" /></template>
              Code
            </IuButton>
            <IuButton size="sm" variant="ghost" :disabled="busy" @click="addCell('markdown')">
              <template #icon><IuIcon name="plus" :size="14" /></template>
              Markdown
            </IuButton>
          </div>
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
.nb-doc__toolbar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 4px 8px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.nb-doc__measure {
  position: absolute;
  display: flex;
  gap: 4px;
  visibility: hidden;
  pointer-events: none;
  height: 0;
  overflow: hidden;
}
.nb-doc__lines {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 16px 0;
}
.nb-doc__line {
  margin: 0;
  font-size: var(--iu-font-size-12);
  overflow-wrap: anywhere;
}
.nb-doc__line--danger {
  color: var(--iu-danger);
}
.nb-doc__dismiss {
  margin-left: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--iu-text-muted);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.nb-doc__dismiss:focus-visible,
.nb-doc__outline-item:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.nb-chip {
  max-width: 220px;
}
.nb-chip--none {
  border-style: dashed;
  color: var(--iu-text-muted);
}
.nb-doc__main {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
}
.nb-doc__main--outline {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 8px;
  padding-left: 12px;
}
.nb-doc__outline {
  align-self: start;
  display: flex;
  flex-direction: column;
  max-height: calc(100% - 24px);
  margin-top: 12px;
  padding: 4px 0;
  overflow: auto;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-md);
  background: var(--iu-surface-raised);
  box-shadow: var(--iu-shadow-raised);
}
.nb-doc__outline-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  padding: 4px 12px;
  border: 0;
  border-left: 2px solid transparent;
  background: transparent;
  color: var(--iu-text-2);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  text-align: left;
  cursor: pointer;
}
.nb-doc__outline-item:hover {
  background: var(--iu-hover);
}
.nb-doc__outline-item--heading {
  color: var(--iu-text);
  font-family: var(--iu-font-sans);
  font-weight: var(--iu-font-weight-semibold);
}
.nb-doc__outline-item--sub {
  padding-left: 24px;
}
.nb-doc__outline-item[aria-current='location'] {
  border-left-color: var(--iu-accent);
  background: var(--iu-hover);
  color: var(--iu-text);
}
.nb-doc__outline-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nb-doc__cells {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow: auto;
  padding: 16px 20px 28px;
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
