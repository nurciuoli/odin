// What the session did to files and notebook cells, read from the transcript alone. The Files tab's "This session" list
// leads with it (files ordered by when the agent last touched them); the thread uses the same lookups to open the
// Files tab at a step's file or notebook cell. Pure, so it is testable without a DOM.
import type { TranscriptEntry } from '@odin/shared/harness'
import { presentTool, toolMeta, toolPath } from '@/components/ToolCall/summary'
import { toolVerbs } from '@/components/ToolCall/verbs'
import type { ToolCallView } from '@/components/ToolCall'
import { relativePath } from '@/components/FilePath/relativePath'
import { toolCallView, type RowContext } from './sessionView'

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>

export type TouchKind = 'read' | 'change'

/** One tool call on a file: a step in the thread. */
export interface FileTouch {
  /** The transcript entry (and rail step) id. */
  entryId: string
  kind: TouchKind
  /** The thread's own verbs for the tool ("Reading" / "Read", "Editing" / "Edited"). */
  verb: { live: string; done: string }
  /** The thread's own result for the step ("+6 −2", "48 lines"); empty when it says nothing. */
  meta: string
  at: string | null
  /** The call as the thread renders it, so the panel can show the same diff. */
  call: ToolCallView
}

export interface TouchedFile {
  /** Relative to the session's working directory, forward slashes; as given when it lies outside. */
  path: string
  /** Whether the session file API can open it (inside the working directory). */
  inside: boolean
  /** Newest first. */
  touches: FileTouch[]
  /** A change that went through (not failed, not refused). */
  changed: boolean
}

const CHANGE = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
const READ = new Set(['Read', 'NotebookRead'])

/** A tool's file path as the session file API wants it; null when it is outside the working directory. */
export function workspacePath(path: string, root?: string | null): string | null {
  const rel = relativePath(path, root)
  if (!rel || rel === '.' || rel.startsWith('/') || rel.startsWith('\\') || /^[a-zA-Z]:/.test(rel))
    return null
  if (rel.split('/').includes('..')) return null
  return rel
}

/** The workspace file a tool entry works on (Read, Edit, MultiEdit, Write, NotebookEdit), else null. */
export function entryFile(entry: TranscriptEntry, root?: string | null): string | null {
  if (entry.kind !== 'tool') return null
  const shown = presentTool(entry)
  if (!CHANGE.has(shown.name) && !READ.has(shown.name)) return null
  const path = toolPath(shown)
  return path ? workspacePath(path, root) : null
}

/**
 * Files the session read or changed, most recently touched first. Changed files and read files share one list:
 * recency is the order, the verb says which.
 */
export function touchedFiles(
  entries: TranscriptEntry[],
  ctx: Pick<RowContext, 'pending' | 'running'> & { root?: string | null },
): TouchedFile[] {
  const files = new Map<string, TouchedFile>()
  for (const entry of entries) {
    if (entry.kind !== 'tool') continue
    const shown = presentTool(entry)
    const change = CHANGE.has(shown.name)
    if (!change && !READ.has(shown.name)) continue
    const raw = toolPath(shown)
    if (!raw) continue
    const inside = workspacePath(raw, ctx.root)
    const path = inside ?? relativePath(raw, ctx.root)
    const call = toolCallView(entry as ToolEntry, ctx)
    const touch: FileTouch = {
      entryId: entry.id,
      kind: change ? 'change' : 'read',
      verb: toolVerbs(shown.name),
      meta:
        call.status === 'failed'
          ? 'failed'
          : call.status === 'cancelled'
            ? (call.statusText ?? 'cancelled').toLowerCase()
            : (toolMeta(call) ?? ''),
      at: entry.at,
      call,
    }
    const file = files.get(path) ?? { path, inside: inside !== null, touches: [], changed: false }
    file.touches.unshift(touch)
    if (change && call.status !== 'failed' && call.status !== 'cancelled') file.changed = true
    // re-insert so the map's order is the order of last touch
    files.delete(path)
    files.set(path, file)
  }
  return [...files.values()].reverse()
}

/** A notebook cell a tool call ran, edited or read the output of. */
export interface CellRef {
  kernelId: string
  cellId: string
}

const NOTEBOOK_TOOL = /(?:^|[_.:-])notebook_(execute|edit|output)$/

/**
 * The cell a notebook host-tool call worked on: `cell_id` from its input, else the `cellId` in the receipt the tool
 * answered with (an appended cell has no id until then). Null for other tools, or while the id is unknown.
 */
export function entryCell(entry: TranscriptEntry): CellRef | null {
  if (entry.kind !== 'tool' || !NOTEBOOK_TOOL.test(entry.name)) return null
  const text = entry.result?.text ?? ''
  const kernelId =
    typeof entry.input.kernel_id === 'string'
      ? entry.input.kernel_id
      : (/"kernelId"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null)
  const cellId =
    typeof entry.input.cell_id === 'string'
      ? entry.input.cell_id
      : (/"cellId"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? null)
  return kernelId && cellId ? { kernelId, cellId } : null
}

/** For each cell (`kernelId/cellId`), the latest step in the thread that worked on it. */
export function cellSteps(entries: TranscriptEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const entry of entries) {
    const ref = entryCell(entry)
    if (ref) out.set(`${ref.kernelId}/${ref.cellId}`, entry.id)
  }
  return out
}
