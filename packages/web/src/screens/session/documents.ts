// The workspace surface's model. Everything the surface opens is a document: a workspace file or a notebook (or the
// page that starts one). Artifacts are not documents; they have their own subpanel. Documents open into one list, one
// of them is on show, and they all close the same way. Pure, so it is testable without a DOM.
import type { NotebookCell, NotebookKernel, NotebookOutput } from '@odin/shared/notebooks'
import type { IconName } from '@/components/Icon'

export type DocRef =
  | { kind: 'file'; path: string }
  | { kind: 'notebook'; kernelId: string }
  /** The page that starts a notebook; it becomes the notebook once one is created. */
  | { kind: 'new-notebook'; name?: string }

export interface OpenDoc {
  /** Stable for as long as the document is open; safe in element ids. */
  key: string
  ref: DocRef
}

/** One identity per document, whatever opened it. */
export function docId(ref: DocRef): string {
  switch (ref.kind) {
    case 'file':
      return `file:${ref.path}`
    case 'notebook':
      return `notebook:${ref.kernelId}`
    case 'new-notebook':
      return 'new-notebook'
  }
}

export interface DocList {
  docs: OpenDoc[]
  /** The key of the document on show; null when nothing is open. */
  active: string | null
  /** Counts keys; never reused, so a reopened document gets a fresh component. */
  seq: number
}

export const emptyDocs = (): DocList => ({ docs: [], active: null, seq: 0 })

export const findDoc = (list: DocList, ref: DocRef) =>
  list.docs.find(d => docId(d.ref) === docId(ref))

/** Open a document (or bring the one already open forward). `select: false` adds it without showing it. */
export function openDoc(list: DocList, ref: DocRef, select = true): DocList {
  const existing = findDoc(list, ref)
  if (existing) return select ? { ...list, active: existing.key } : list
  const seq = list.seq + 1
  const doc: OpenDoc = { key: `d${seq}`, ref }
  return {
    docs: [...list.docs, doc],
    active: select || list.active === null ? doc.key : list.active,
    seq,
  }
}

/** Close a document. When it was on show its right-hand neighbour takes over, else the left one. */
export function closeDoc(list: DocList, key: string): DocList {
  const index = list.docs.findIndex(d => d.key === key)
  if (index < 0) return list
  const docs = list.docs.filter(d => d.key !== key)
  const active =
    list.active === key ? (docs[index]?.key ?? docs[index - 1]?.key ?? null) : list.active
  return { ...list, docs, active }
}

/** Swap a document for another in place (the new-notebook page becoming its notebook). */
export function replaceDoc(list: DocList, key: string, ref: DocRef): DocList {
  const existing = findDoc(list, ref)
  if (existing) return { ...closeDoc(list, key), active: existing.key }
  return { ...list, docs: list.docs.map(d => (d.key === key ? { ...d, ref } : d)) }
}

// ── names ──

/** A path relative to the session's working directory, slash-separated. */
export function relativePath(cwd: string, path: string): string {
  const root = cwd.replaceAll('\\', '/').replace(/\/$/, '')
  const normalized = path.replaceAll('\\', '/')
  return normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : normalized
}

export const baseName = (path: string) => path.split('/').at(-1) ?? path
export const parentPath = (path: string) => path.split('/').slice(0, -1).join('/')
/** Every folder above a file, outermost first: `a/b/c.md` gives `a`, `a/b`. */
export function ancestors(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** A notebook reads as the file it is. */
export const notebookFileName = (name: string) => (/\.ipynb$/i.test(name) ? name : `${name}.ipynb`)

export type FileKind = 'markdown' | 'table' | 'notebook' | 'text'
export function fileKind(path: string): FileKind {
  if (/\.md$/i.test(path)) return 'markdown'
  if (/\.(csv|tsv)$/i.test(path)) return 'table'
  if (/\.ipynb$/i.test(path)) return 'notebook'
  return 'text'
}

export function fileIcon(path: string): IconName {
  const kind = fileKind(path)
  return kind === 'table' ? 'database' : kind === 'notebook' ? 'terminal' : 'file'
}

export interface DocLabel {
  /** Short name for the switcher. */
  name: string
  /** Where it lives, outermost first; the name is the last crumb. */
  crumbs: string[]
  icon: IconName
}

export function docLabel(ref: DocRef, ctx: { kernels: readonly NotebookKernel[] }): DocLabel {
  switch (ref.kind) {
    case 'file':
      return { name: baseName(ref.path), crumbs: ref.path.split('/'), icon: fileIcon(ref.path) }
    case 'notebook': {
      const kernel = ctx.kernels.find(k => k.id === ref.kernelId)
      const name = notebookFileName(kernel?.name ?? 'Notebook')
      return { name, crumbs: ['Notebooks', name], icon: 'terminal' }
    }
    case 'new-notebook':
      return { name: 'New notebook', crumbs: ['Notebooks', 'New notebook'], icon: 'terminal' }
  }
}

// ── .ipynb files ──

const text = (value: unknown): string =>
  Array.isArray(value) ? value.join('') : typeof value === 'string' ? value : ''

function ipynbOutput(raw: unknown): NotebookOutput | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.output_type === 'stream')
    return { type: 'stream', name: o.name === 'stderr' ? 'stderr' : 'stdout', text: text(o.text) }
  if (o.output_type === 'error')
    return {
      type: 'error',
      name: text(o.ename),
      message: text(o.evalue),
      traceback: Array.isArray(o.traceback) ? o.traceback.map(String) : [],
    }
  if (o.output_type === 'display_data' || o.output_type === 'execute_result') {
    const data: Record<string, unknown> = {}
    if (o.data && typeof o.data === 'object')
      for (const [mime, value] of Object.entries(o.data as Record<string, unknown>))
        data[mime] = Array.isArray(value) ? value.join('') : value
    return { type: 'display', data }
  }
  return null
}

/** The cells of a notebook file as saved on disk (nbformat 4), or null when the text is not a notebook. */
export function parseIpynb(source: string): NotebookCell[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    return null
  }
  const cells = (parsed as { cells?: unknown } | null)?.cells
  if (!Array.isArray(cells)) return null
  return cells
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
    .filter(c => c.cell_type === 'code' || c.cell_type === 'markdown')
    .map((c, index): NotebookCell => {
      const kind = c.cell_type === 'code' ? 'code' : 'markdown'
      return {
        id: typeof c.id === 'string' ? c.id : `cell-${index}`,
        kind,
        source: text(c.source),
        outputs:
          kind === 'code' && Array.isArray(c.outputs)
            ? c.outputs.map(ipynbOutput).filter((o): o is NotebookOutput => o !== null)
            : [],
        executionCount: typeof c.execution_count === 'number' ? c.execution_count : null,
        author: { kind: 'human' },
      }
    })
}
