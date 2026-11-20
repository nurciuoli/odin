// One way to name a checkout: `main · odin`, or `feat/x · feat-x` for a worktree. The folder is the project
// (or its title, when the caller has one) for the main checkout, and the worktree's directory otherwise.
import type { Session, Workspace } from '@odin/shared/api'

export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function placeFolder(
  session: { project: string; workspace: Workspace },
  checkoutName?: string | null,
): string {
  if (session.workspace.kind === 'worktree') return folderName(session.workspace.path)
  return checkoutName?.trim() || session.project
}

/** `main · odin`. Either half alone when the other is missing. */
export function placeLabel(
  branch: string | null | undefined,
  folder: string | null | undefined,
): string {
  const b = branch?.trim() ?? ''
  const f = folder?.trim() ?? ''
  if (b && f) return `${b} · ${f}`
  return b || f
}

/** The working checkout, plus ` +N` when the session has other repositories. */
export function sessionPlace(
  session: Pick<Session, 'branch' | 'project' | 'workspace' | 'projects'>,
  checkoutName?: string | null,
): string {
  const place = placeLabel(session.branch, placeFolder(session, checkoutName))
  const extra = Math.max(0, (session.projects?.length || 1) - 1)
  return extra ? `${place} +${extra}` : place
}
