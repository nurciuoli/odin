import type { NotebookExecution, NotebookKernel, NotebookSnapshot } from '@odin/shared/notebooks'
import type { ServerEvent } from '@odin/shared/events'
import type { Api } from './types'
import { ApiRequestError } from './types'
import { FIXTURE_SESSION_IDS } from './fixtures'

export function mockNotebooks(options: {
  project: (name: string) => { path: string }
  session: (id: string) => { project: string }
  emit: (event: ServerEvent) => void
}) {
  const notebooks = new Map<string, NotebookSnapshot>()
  const links = new Map<string, Set<string>>()
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
    async handoffNotebook(id) {
      get(id).editor = 'jupyterlab'
      changed(get(id))
      return { url: '#mock-jupyterlab' }
    },
    async reclaimNotebook(id) {
      get(id).editor = 'odin'
      changed(get(id))
      return copy(get(id))
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
    async createNotebook(project, req) {
      const root = options.project(project)
      if (!req.name.trim()) throw new ApiRequestError(400, 'Name is required')
      if (
        [...notebooks.values()].some(
          n => n.kernel.project === project && n.kernel.name === req.name,
        )
      )
        throw new ApiRequestError(409, 'Kernel name already exists')
      const time = new Date().toISOString()
      const kernel: NotebookKernel = {
        id: `notebook-${++sequence}`,
        project,
        name: req.name,
        cwd: req.cwd || root.path,
        interpreter: req.interpreter || '.venv/bin/python',
        location: req.location || { kind: 'native' },
        state: 'stopped',
        createdAt: time,
        updatedAt: time,
        error: null,
      }
      const snapshot: NotebookSnapshot = {
        kernel,
        revision: String(++sequence),
        cells: [],
        editor: 'odin',
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
      if (snapshot.editor !== 'odin' || snapshot.revision !== revision)
        throw new ApiRequestError(409, 'Notebook changed; reload before saving')
      snapshot.cells = copy(cells)
      changed(snapshot)
      return copy(snapshot)
    },
    async sessionNotebooks(id) {
      options.session(id)
      return copy([...(links.get(id) ?? [])].map(key => get(key).kernel))
    },
    async attachNotebook(id, kernelId) {
      if (options.session(id).project !== get(kernelId).kernel.project)
        throw new ApiRequestError(400, 'Kernel belongs to another project')
      const set = links.get(id) ?? new Set<string>()
      set.add(kernelId)
      links.set(id, set)
    },
    async executeNotebook(id, req) {
      const snapshot = get(id)
      if (snapshot.revision !== req.revision || snapshot.editor !== 'odin')
        throw new ApiRequestError(409, 'Notebook changed; reload before running')
      const cell = snapshot.cells.find(c => c.id === req.cellId)
      if (!cell || cell.kind !== 'code') throw new ApiRequestError(400, 'Select a code cell')
      const time = new Date().toISOString()
      const execution: NotebookExecution = {
        id: `execution-${++sequence}`,
        kernelId: id,
        cellId: cell.id,
        sessionId: null,
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
      for (const set of links.values()) set.delete(id)
    },
    async exportNotebook(id, path) {
      get(id)
      if (!path.endsWith('.ipynb') || path.includes('..'))
        throw new ApiRequestError(400, 'Choose a relative .ipynb path')
      return { path }
    },
    notebookOutputUrl: (id, cellId, index) =>
      `/a/notebooks/${encodeURIComponent(id)}/${encodeURIComponent(cellId)}/${index}`,
  } satisfies Pick<
    Api,
    | 'handoffNotebook'
    | 'notebookWidgetState'
    | 'sendNotebookComm'
    | 'reclaimNotebook'
    | 'notebookEnvironment'
    | 'setupNotebookEnvironment'
    | 'notebookVariables'
    | 'notebookDataFrame'
    | 'listNotebooks'
    | 'createNotebook'
    | 'getNotebook'
    | 'saveNotebook'
    | 'sessionNotebooks'
    | 'attachNotebook'
    | 'executeNotebook'
    | 'notebookExecution'
    | 'interruptNotebook'
    | 'stopNotebook'
    | 'removeNotebook'
    | 'exportNotebook'
    | 'notebookOutputUrl'
  >
  // One notebook the idle fixture session already uses, so the surface has something to show.
  try {
    const owner = options.session(FIXTURE_SESSION_IDS.idle)
    const stamp = new Date().toISOString()
    const text = (
      id: string,
      kind: 'code' | 'markdown',
      source: string,
      outputs: NotebookSnapshot['cells'][number]['outputs'] = [],
      n: number | null = null,
    ) => ({
      id,
      kind,
      source,
      outputs,
      executionCount: n,
      author: { kind: 'agent' as const, sessionId: FIXTURE_SESSION_IDS.idle },
    })
    notebooks.set('notebook-seed', {
      kernel: {
        id: 'notebook-seed',
        project: owner.project,
        name: 'Revenue analysis',
        cwd: '/home/me/code/odin',
        interpreter: '.venv/bin/python',
        location: { kind: 'native' },
        state: 'idle',
        createdAt: stamp,
        updatedAt: stamp,
        error: null,
      },
      revision: '1',
      editor: 'odin',
      cells: [
        text(
          'c1',
          'markdown',
          '# Revenue by quarter\n\nLoad the export, then compare **Q1** against **Q2**.',
        ),
        text(
          'c2',
          'code',
          "import pandas as pd\n\ndata = pd.read_csv('data/revenue.csv')\nprint(data.shape)",
          [{ type: 'stream', name: 'stdout', text: '(128, 4)\n' }],
          1,
        ),
        text(
          'c3',
          'code',
          "data.groupby('quarter').revenue.sum()",
          [
            {
              type: 'display',
              data: {
                'text/plain': 'quarter\nQ1    412300\nQ2    468900\nName: revenue, dtype: int64',
              },
            },
          ],
          2,
        ),
        text('c4', 'code', 'data.plot()', [], null),
      ],
    })
    links.set(FIXTURE_SESSION_IDS.idle, new Set(['notebook-seed']))
  } catch {
    // a mock without the fixture session has no notebook to seed
  }
  return methods
}
