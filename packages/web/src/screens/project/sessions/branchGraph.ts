// Branches section of the Sessions tab: ProjectBranch rows → IuBranchGraph input, plus the table's row rules.
// x is commit order, not time: the trunk's tip is the rightmost point, a branch forks `behind` commits before it and
// runs `ahead` commits.
import type { RouteLocationRaw } from 'vue-router'
import type { ProjectBranch, Session, SessionState } from '@odin/shared/api'

export type GraphIntent = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger'

export interface GraphMark {
  at: number
  intent: GraphIntent
  label: string
  to?: RouteLocationRaw
}

export interface GraphBranch {
  name: string
  forkAt: number
  length: number
  intent: GraphIntent
  dashed?: boolean
  end?: 'merged' | 'open' | 'none'
  marks: GraphMark[]
}

/** A worktree whose branch saw no commit for this long is stale. */
export const STALE_MS = 14 * 24 * 60 * 60 * 1000

const LIVE: SessionState[] = ['running', 'waiting']
const STATE_INTENT: Record<SessionState, GraphIntent> = {
  running: 'accent',
  waiting: 'warning',
  idle: 'neutral',
  ended: 'neutral',
  failed: 'danger',
}

export type BranchKind = 'current' | 'merged' | 'pull' | 'stale' | 'open'

export function branchKind(b: ProjectBranch, now: number): BranchKind {
  if (b.current) return 'current'
  if (b.merged) return 'merged'
  if (b.pull?.state === 'open') return 'pull'
  const age = now - Date.parse(b.lastCommitAt)
  if (b.worktreePath && Number.isFinite(age) && age > STALE_MS) return 'stale'
  return 'open'
}

export const KIND_LABEL: Record<BranchKind, string> = {
  current: 'Checked out',
  merged: 'Merged',
  pull: 'Open PR',
  stale: 'Stale',
  open: 'Open',
}

const KIND_INTENT: Record<BranchKind, GraphIntent> = {
  current: 'accent',
  merged: 'positive',
  pull: 'accent',
  stale: 'warning',
  open: 'neutral',
}

/** Remove worktree is offered on merged or stale worktrees that no live session uses. */
export function canRemoveWorktree(
  b: ProjectBranch,
  sessions: Map<string, Pick<Session, 'state'>>,
  now: number,
): boolean {
  if (!b.worktreePath || b.current) return false
  const kind = branchKind(b, now)
  if (kind !== 'merged' && kind !== 'stale') return false
  return !b.sessionIds.some(id => {
    const s = sessions.get(id)
    return s ? LIVE.includes(s.state) : false
  })
}

export interface BranchGraphInput {
  trunk: string
  branches: GraphBranch[]
}

export function branchGraph(
  trunk: string,
  branches: ProjectBranch[],
  sessions: Map<string, Pick<Session, 'id' | 'title' | 'state'>>,
  now: number,
): BranchGraphInput {
  const side = branches.filter(b => b.name !== trunk)
  const tip = Math.max(1, ...side.map(b => b.behind + 1))
  return {
    trunk,
    branches: side
      .slice()
      .sort((a, b) => b.behind - a.behind || a.name.localeCompare(b.name))
      .map(b => {
        const kind = branchKind(b, now)
        const forkAt = tip - b.behind
        const length = Math.max(1, b.ahead)
        const linked = b.sessionIds
          .map(id => sessions.get(id))
          .filter((s): s is Pick<Session, 'id' | 'title' | 'state'> => !!s)
        const marks: GraphMark[] = linked.map((s, i) => ({
          at: forkAt + Math.max(1, Math.round(((i + 1) * length) / (linked.length + 1))),
          intent: STATE_INTENT[s.state],
          label: `Session: ${s.title}`,
          to: { name: 'session', params: { id: s.id } },
        }))
        if (b.pull)
          marks.push({
            at: forkAt + length,
            intent: b.pull.merged ? 'positive' : b.pull.state === 'open' ? 'accent' : 'neutral',
            label: `PR #${b.pull.number} ${b.pull.merged ? 'merged' : b.pull.state}`,
          })
        return {
          name: b.name,
          forkAt,
          length,
          intent: KIND_INTENT[kind],
          dashed: b.worktreePath !== null,
          end: b.merged ? 'merged' : b.pull?.state === 'open' ? 'open' : 'none',
          marks,
        }
      }),
  }
}
