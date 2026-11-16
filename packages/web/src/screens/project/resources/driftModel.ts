// Installed library assets as the tab shows them: what each drift state means and which actions it offers. Pure.
import type { AssetFiles, DriftState, Installation } from '@odin/shared/api'
import { diffLines, type DiffHunk } from '@/components/CodeBlock'
import type { Intent } from '@/styles/status'

export interface DriftDisplay {
  intent: Intent
  label: string
  /** One sentence for what it means, shown beside the badge so the state is never colour-only. */
  text: string
}

export const DRIFT_DISPLAY: Record<DriftState, DriftDisplay> = {
  current: {
    intent: 'positive',
    label: 'Current',
    text: 'The project copy matches the library.',
  },
  'update-available': {
    intent: 'info',
    label: 'Update available',
    text: 'The library has a newer version; the project copy is untouched.',
  },
  modified: {
    intent: 'warning',
    label: 'Modified here',
    text: 'The project copy was changed; the library version did not move.',
  },
  conflict: {
    intent: 'danger',
    label: 'Conflict',
    text: 'Both the project copy and the library changed since install.',
  },
  missing: {
    intent: 'warning',
    label: 'Missing',
    text: 'The files are gone from the project.',
  },
}

export type DriftAction = 'update' | 'overwrite' | 'push' | 'forget' | 'diff'

export interface DriftActionDef {
  id: DriftAction
  label: string
  /** Needs a confirmation: it overwrites files in the project or the library. */
  confirm: boolean
}

/** What can be done about an installation in this state. `forget` (keep the files, stop tracking) is always there. */
export function driftActions(state: DriftState): DriftActionDef[] {
  const out: DriftActionDef[] = []
  if (state === 'update-available') out.push({ id: 'update', label: 'Update', confirm: false })
  if (state === 'missing') out.push({ id: 'update', label: 'Reinstall', confirm: false })
  if (state === 'update-available' || state === 'modified' || state === 'conflict')
    out.push({ id: 'diff', label: 'View diff', confirm: false })
  if (state === 'modified' || state === 'conflict') {
    out.push({ id: 'push', label: 'Push back to library', confirm: true })
    out.push({ id: 'overwrite', label: 'Reset to library version', confirm: true })
  }
  out.push({ id: 'forget', label: 'Keep and stop tracking', confirm: false })
  return out
}

export interface FileDiff {
  path: string
  hunks: DiffHunk[]
  /** False when the file exists on one side only. */
  both: boolean
}

/** Library files against the project's, one diff per path, sorted. Library is "before", the project "after". */
export function assetDiff(library: AssetFiles, project: AssetFiles): FileDiff[] {
  const paths = [...new Set([...Object.keys(library), ...Object.keys(project)])].sort()
  return paths.map(path => ({
    path,
    hunks: diffLines(library[path] ?? '', project[path] ?? ''),
    both: path in library && path in project,
  }))
}

export function installKey(i: Pick<Installation, 'kind' | 'id'>): string {
  return `${i.kind}/${i.id}`
}
