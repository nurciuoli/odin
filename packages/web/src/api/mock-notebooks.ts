import type {
  NotebookCell,
  NotebookExecution,
  NotebookKernel,
  NotebookSnapshot,
} from '@odin/shared/notebooks'
import type { ServerEvent } from '@odin/shared/events'
import type { Api } from './types'
import { ApiRequestError } from './types'

const EMPTY_NOTEBOOK = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 })

function displayOutputs(raw: unknown): NotebookCell['outputs'] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap(o => {
    const data = (o as { data?: Record<string, unknown> }).data
    if (!data) return []
    const joined = Object.fromEntries(
      Object.entries(data).map(([mime, v]) => [mime, Array.isArray(v) ? v.join('') : v]),
    )
    return [{ type: 'display' as const, data: joined }]
  })
}

/** Cells of an .ipynb file's text (code and Markdown cells; display outputs are kept). */
function cellsOf(source: string): NotebookCell[] {
  try {
    const cells = (JSON.parse(source) as { cells?: Record<string, unknown>[] }).cells ?? []
    return cells
      .filter(c => c.cell_type === 'code' || c.cell_type === 'markdown')
      .map((c, i) => ({
        id: typeof c.id === 'string' ? c.id : `cell-${i}`,
        kind: c.cell_type === 'code' ? ('code' as const) : ('markdown' as const),
        source: Array.isArray(c.source) ? c.source.join('') : String(c.source ?? ''),
        outputs: displayOutputs(c.outputs),
        executionCount: typeof c.execution_count === 'number' ? c.execution_count : null,
      }))
  } catch {
    return []
  }
}

export function mockNotebooks(options: {
  project: (name: string) => { path: string }
  session: (id: string) => { project: string }
  emit: (event: ServerEvent) => void
  /** The project's files: notebooks are .ipynb files in it. */
  files: { read: (path: string) => string | undefined; write: (path: string, text: string) => void }
}) {
  const notebooks = new Map<string, NotebookSnapshot>()
  const executions = new Map<string, NotebookExecution>()
  let sequence = 0
  const copy = <T>(value: T): T => structuredClone(value)
  function get(id: string) {
    const found = notebooks.get(id)
    if (!found) throw new ApiRequestError(404, 'Notebook not found')
    return found
  }
  function changed(snapshot: NotebookSnapshot) {
    snapshot.revision = String(++sequence)
    snapshot.kernel.updatedAt = new Date().toISOString()
    options.emit({
      type: 'notebook.updated',
      kernelId: snapshot.kernel.id,
      project: snapshot.kernel.project,
      revision: snapshot.revision,
    })
  }
  const methods = {
    async notebookWidgetState(id) {
      get(id)
      return []
    },
    async sendNotebookComm(id, message) {
      get(id)
      options.emit({ type: 'notebook.comm', kernelId: id, message })
    },
    async notebookEnvironment(project) {
      options.project(project)
      return {
        kind: 'venv' as const,
        interpreter: '.venv/bin/python',
        managedHostPython: 'odin/python',
        needsSetup: false,
      }
    },
    async setupNotebookEnvironment(project) {
      options.project(project)
      return {
        kind: 'venv' as const,
        interpreter: '.venv/bin/python',
        managedHostPython: 'odin/python',
        needsSetup: false,
      }
    },
    async notebookVariables(id) {
      get(id)
      return [{ name: 'data', type: 'DataFrame', preview: 'Mock dataset', shape: [3, 2] }]
    },
    async notebookDataFrame(id, name, query) {
      get(id)
      if (name !== 'data') throw new ApiRequestError(404, 'Variable not found')
      const rows: unknown[][] = [
        ['Alpha', 2],
        ['Beta', 1],
        ['Gamma', 3],
      ]
      if (query.sort)
        rows.sort(
          (a, b) =>
            String(a[query.sort === 'name' ? 0 : 1]).localeCompare(
              String(b[query.sort === 'name' ? 0 : 1]),
            ) * (query.descending ? -1 : 1),
        )
      const offset = query.offset ?? 0
      const limit = query.limit ?? 50
      return {
        columns: [
          { name: 'name', type: 'str' },
          { name: 'value', type: 'int' },
        ],
        rows: rows.slice(offset, offset + limit),
        total: 3,
        offset,
        limit,
      }
    },
    async listNotebooks(project) {
      options.project(project)
      return copy(
        [...notebooks.values()].filter(n => n.kernel.project === project).map(n => n.kernel),
      )
    },
    async openNotebook(project, req) {
      const root = options.project(project)
      if (req.sessionId && options.session(req.sessionId).project !== project)
        throw new ApiRequestError(400, 'Session belongs to another project')
      const path = req.path
      if (!path.endsWith('.ipynb') || path.startsWith('/') || path.split('/').includes('..'))
        throw new ApiRequestError(400, 'Choose a project-relative .ipynb path')
      const existing = [...notebooks.values()].find(
        n => n.kernel.project === project && n.kernel.path === path,
      )
      if (existing) {
        if (req.interpreter && !existing.kernel.interpreter) {
          existing.kernel.interpreter = req.interpreter
          existing.kernel.location = req.location ?? existing.kernel.location
          changed(existing)
        }
        return copy(existing.kernel)
      }
      const source = options.files.read(path)
      if (source === undefined) {
        if (!req.create) throw new ApiRequestError(404, 'Notebook not found')
        options.files.write(path, EMPTY_NOTEBOOK)
      }
      const time = new Date().toISOString()
      const kernel: NotebookKernel = {
        id: `notebook-${++sequence}`,
        project,
        path,
        name: path.split('/').at(-1)!,
        cwd: root.path,
        interpreter: req.interpreter ?? '',
        location: req.location ?? { kind: 'native' },
        state: 'stopped',
        createdAt: time,
        updatedAt: time,
        error: null,
      }
      const snapshot: NotebookSnapshot = {
        kernel,
        revision: String(++sequence),
        cells: cellsOf(source ?? EMPTY_NOTEBOOK),
      }
      notebooks.set(kernel.id, snapshot)
      changed(snapshot)
      return copy(kernel)
    },
    async getNotebook(id) {
      return copy(get(id))
    },
    async saveNotebook(id, revision, cells) {
      const snapshot = get(id)
      if (snapshot.revision !== revision)
        throw new ApiRequestError(409, 'Notebook changed; reload before saving')
      snapshot.cells = copy(cells)
      changed(snapshot)
      return copy(snapshot)
    },
    async executeNotebook(id, req) {
      const snapshot = get(id)
      if (snapshot.revision !== req.revision)
        throw new ApiRequestError(409, 'Notebook changed; reload before running')
      if (!snapshot.kernel.interpreter) throw new ApiRequestError(409, 'no Python environment')
      const cell = snapshot.cells.find(c => c.id === req.cellId)
      if (!cell || cell.kind !== 'code') throw new ApiRequestError(400, 'Select a code cell')
      const time = new Date().toISOString()
      const execution: NotebookExecution = {
        id: `execution-${++sequence}`,
        kernelId: id,
        cellId: cell.id,
        state: 'completed',
        startedAt: time,
        finishedAt: time,
        error: null,
      }
      snapshot.kernel.state = 'idle'
      cell.outputs = [
        {
          type: 'stream',
          name: 'stdout',
          text: 'Mock output: Python is not executed in this preview.\n',
        },
      ]
      cell.executionCount = (cell.executionCount ?? 0) + 1
      executions.set(execution.id, execution)
      changed(snapshot)
      options.emit({ type: 'notebook.execution', execution: copy(execution) })
      return copy(execution)
    },
    async notebookExecution(id) {
      const execution = executions.get(id)
      if (!execution) throw new ApiRequestError(404, 'Execution not found')
      return copy(execution)
    },
    async interruptNotebook(id) {
      get(id).kernel.state = 'idle'
      changed(get(id))
    },
    async stopNotebook(id) {
      get(id).kernel.state = 'stopped'
      changed(get(id))
    },
    async removeNotebook(id) {
      get(id)
      notebooks.delete(id)
    },
    notebookOutputUrl: (id, cellId, index) =>
      `/a/notebooks/${encodeURIComponent(id)}/${encodeURIComponent(cellId)}/${index}`,
  } satisfies Pick<
    Api,
    | 'notebookWidgetState'
    | 'sendNotebookComm'
    | 'notebookEnvironment'
    | 'setupNotebookEnvironment'
    | 'notebookVariables'
    | 'notebookDataFrame'
    | 'listNotebooks'
    | 'openNotebook'
    | 'getNotebook'
    | 'saveNotebook'
    | 'executeNotebook'
    | 'notebookExecution'
    | 'interruptNotebook'
    | 'stopNotebook'
    | 'removeNotebook'
    | 'notebookOutputUrl'
  >
  return methods
}
