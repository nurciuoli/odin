import type { ProjectBranch } from '@odin/shared/api'

export type TreeFilter = 'all' | 'active' | 'merged'
export type TreeDensity = 'comfortable' | 'compact'
export type NodeKind = 'default' | 'active' | 'merged'

export interface TreeRow {
  branch: ProjectBranch
  kind: NodeKind
  /** 0 is the trunk (default and merged branches sit on it); open branches alternate over lanes 1..LANES so elbows never cross a neighbour's node. */
  lane: number
  stale: boolean
  worktree: boolean
}

export const LANES = 3
export const STALE_MS = 30 * 24 * 60 * 60 * 1000
export const ROW_HEIGHT: Record<TreeDensity, number> = { comfortable: 52, compact: 32 }

export function kindOf(b: ProjectBranch, defaultBranch: string): NodeKind {
  if (b.name === defaultBranch) return 'default'
  return b.merged ? 'merged' : 'active'
}

/** Default branch first, then newest commit first. Filters keep the default branch whatever they hide. */
export function treeRows(
  branches: ProjectBranch[],
  defaultBranch: string,
  opts: { filter: TreeFilter; worktreesOnly: boolean },
  now: number = Date.now(),
): TreeRow[] {
  const sorted = [...branches].sort(
    (a, b) =>
      Number(b.name === defaultBranch) - Number(a.name === defaultBranch) ||
      b.lastCommitAt.localeCompare(a.lastCommitAt),
  )
  let n = 0
  const rows: TreeRow[] = []
  for (const b of sorted) {
    const kind = kindOf(b, defaultBranch)
    const worktree = b.worktreePath !== null && !b.current
    if (kind !== 'default') {
      if (opts.filter === 'active' && kind === 'merged') continue
      if (opts.filter === 'merged' && kind !== 'merged') continue
      if (opts.worktreesOnly && !worktree) continue
    }
    rows.push({
      branch: b,
      kind,
      lane: kind === 'active' ? (n++ % LANES) + 1 : 0,
      stale: kind === 'active' && now - Date.parse(b.lastCommitAt) > STALE_MS,
      worktree,
    })
  }
  return rows
}

function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}
export function branchUrl(repo: string | null, name: string): string | null {
  return repo ? `https://github.com/${repo}/tree/${encodePath(name)}` : null
}
export function commitUrl(repo: string | null, sha: string): string | null {
  return repo ? `https://github.com/${repo}/commit/${encodeURIComponent(sha)}` : null
}
export function compareUrl(repo: string | null, base: string, name: string): string | null {
  return repo
    ? `https://github.com/${repo}/compare/${encodePath(base)}...${encodePath(name)}`
    : null
}
