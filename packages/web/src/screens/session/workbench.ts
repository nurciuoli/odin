// The workbench column's data, from the session detail alone: the plan (todo list, else the latest ExitPlanMode
// plan), the files it changed with rough line counts, and which tab to open on.
import type { SessionDetail } from '@odin/shared/api'
import type { TranscriptEntry } from '@odin/shared/harness'
import { filesChanged, type ChangedFile } from './sessionView'

export type WorkbenchTab = 'plan' | 'changes' | 'artifacts' | 'files'

/** What the session screen's preview pane shows: the document surface (files, notebooks, artifacts), an agent's activity, or side threads. */
export type PreviewView = 'docs' | 'activity' | 'side'

export interface FileChange extends ChangedFile {
  /** Lines written and replaced, estimated from the edit inputs (an Edit's new/old strings, a Write's content). */
  added: number
  removed: number
}

const lines = (s: unknown) => (typeof s === 'string' && s ? s.split('\n').length : 0)

/** filesChanged, plus line counts from the calls' inputs (successful calls only). */
export function fileChanges(entries: TranscriptEntry[]): FileChange[] {
  const counts = new Map<string, { added: number; removed: number }>()
  for (const e of entries) {
    if (e.kind !== 'tool' || e.result?.ok === false) continue
    const path = e.input.file_path ?? e.input.target_file ?? e.input.notebook_path ?? e.input.path
    if (typeof path !== 'string') continue
    const c = counts.get(path) ?? { added: 0, removed: 0 }
    if (e.name === 'Edit' || e.name === 'search_replace') {
      c.added += lines(e.input.new_string)
      c.removed += lines(e.input.old_string)
    } else if (e.name === 'MultiEdit' && Array.isArray(e.input.edits)) {
      for (const x of e.input.edits as { new_string?: unknown; old_string?: unknown }[]) {
        c.added += lines(x?.new_string)
        c.removed += lines(x?.old_string)
      }
    } else if (e.name === 'Write' || e.name === 'write' || e.name === 'write_file') {
      c.added += lines(e.input.content)
    } else if (e.name === 'NotebookEdit') {
      c.added += lines(e.input.new_source)
    }
    counts.set(path, c)
  }
  return filesChanged(entries).map(f => ({
    ...f,
    ...(counts.get(f.path) ?? { added: 0, removed: 0 }),
  }))
}

/** The latest plan the agent proposed (ExitPlanMode), when there is one. */
export function latestPlan(entries: TranscriptEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.kind === 'tool' && e.name === 'ExitPlanMode' && typeof e.input.plan === 'string')
      return e.input.plan
  }
  return null
}

/** Where the column opens: artifacts when there are any, else the plan, else the changes. */
export function defaultTab(
  detail: Pick<SessionDetail, 'artifacts' | 'todos' | 'transcript'>,
): WorkbenchTab {
  if (detail.artifacts.length) return 'artifacts'
  if (detail.todos.length || latestPlan(detail.transcript)) return 'plan'
  return 'changes'
}

/** Whether the column has anything to show. */
export function hasWork(
  detail: Pick<SessionDetail, 'artifacts' | 'todos' | 'transcript'>,
): boolean {
  return (
    detail.artifacts.length > 0 ||
    detail.todos.length > 0 ||
    latestPlan(detail.transcript) !== null ||
    filesChanged(detail.transcript).length > 0
  )
}
