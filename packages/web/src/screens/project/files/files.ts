// The file tree the Files tab maps (built from GET /api/projects/:name/files/map) and the pure helpers over it.
import type { ProjectMapFile } from '@odin/shared/api'

export type FileKind = 'folder' | 'code' | 'test' | 'config' | 'doc' | 'schema'

export interface Delta {
  added: number
  removed: number
  /** Lines in the file now, to judge how much of it changed. */
  lines: number
}

export interface FileNode {
  id: string
  name: string
  kind: FileKind
  bytes: number
  delta?: Delta
  children?: FileNode[]
}

export type FileIndex = Map<string, { node: FileNode; parent: string | null }>

export function nodeBytes(n: FileNode): number {
  return n.kind === 'folder' ? (n.children ?? []).reduce((t, c) => t + nodeBytes(c), 0) : n.bytes
}

export function indexTree(root: FileNode): FileIndex {
  const map: FileIndex = new Map()
  const walk = (n: FileNode, parent: string | null) => {
    map.set(n.id, { node: n, parent })
    for (const c of n.children ?? []) walk(c, n.id)
  }
  walk(root, null)
  return map
}

/** Root to `id`, for the breadcrumb. */
export function chain(idx: FileIndex, id: string): FileNode[] {
  const out: FileNode[] = []
  let cur: string | null = id
  while (cur !== null) {
    const e = idx.get(cur)
    if (!e) break
    out.unshift(e.node)
    cur = e.parent
  }
  return out
}

export function under(idx: FileIndex, folderId: string, id: string): boolean {
  let cur: string | null = id
  while (cur !== null) {
    if (cur === folderId) return true
    cur = idx.get(cur)?.parent ?? null
  }
  return false
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`
}

export function deltaText(d?: Delta): string {
  if (!d) return ''
  return [d.added ? `+${d.added}` : '', d.removed ? `−${d.removed}` : ''].filter(Boolean).join(' ')
}

/** Strength of a diff tint, 0–100: how much of the file changed, eased so small edits still show. */
export function tintPercent(d: Delta | undefined): number {
  if (!d) return 0
  const total = d.added + d.removed
  if (!total) return 0
  const share = Math.min(1, total / Math.max(d.lines, 1))
  const s = share < 0.08 ? share * 2.2 : Math.min(1, 0.2 + 0.8 * Math.pow(share, 0.62))
  return Math.round(s * 70)
}

/** Which way a file leans: all added, all removed, or a mix (with the added share, 0–100). */
export function lean(d: Delta): { kind: 'add' | 'remove' | 'mix'; addPercent: number } {
  const total = d.added + d.removed
  const share = total ? d.added / total : 0
  const addPercent = Math.round(share * 100)
  if (d.removed === 0 || share > 0.92) return { kind: 'add', addPercent }
  if (d.added === 0 || share < 0.08) return { kind: 'remove', addPercent }
  return { kind: 'mix', addPercent }
}

const kindOf = (path: string): FileKind => {
  if (/\.(test|spec)\./.test(path)) return 'test'
  if (/\.(md|mdx|txt)$/.test(path)) return 'doc'
  if (/\.sql$/.test(path)) return 'schema'
  if (/\.(json|ya?ml|toml|lock)$/.test(path)) return 'config'
  return 'code'
}

/** Folds the API's flat file list into a tree rooted at `name`; folder ids are their paths, the root's is ''. */
export function buildTree(name: string, files: ProjectMapFile[]): FileNode {
  const root: FileNode = { id: '', name, kind: 'folder', bytes: 0, children: [] }
  const dirs = new Map<string, FileNode>([['', root]])
  for (const f of files) {
    const parts = f.path.split('/')
    let dir = root
    parts.slice(0, -1).forEach((part, i) => {
      const id = parts.slice(0, i + 1).join('/')
      let next = dirs.get(id)
      if (!next) {
        next = { id, name: part, kind: 'folder', bytes: 0, children: [] }
        dirs.set(id, next)
        dir.children!.push(next)
      }
      dir = next
    })
    const node: FileNode = { id: f.path, name: parts.at(-1)!, kind: kindOf(f.path), bytes: f.size }
    if (f.added || f.removed) {
      node.delta = { added: f.added ?? 0, removed: f.removed ?? 0, lines: f.lines ?? 0 }
    }
    dir.children!.push(node)
  }
  return root
}
