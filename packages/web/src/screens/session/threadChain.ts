// A session's thread for the side column: its root session and every fork under it, the branches and PRs they
// worked on and their artifacts. Pure, so it is tested without a DOM.
import type { Artifact, PullRef, Session } from '@odin/shared/api'

export type ThreadState = 'needs-you' | 'running' | 'open' | 'done'

export const THREAD_STATE_LABEL: Record<ThreadState, string> = {
  'needs-you': 'Needs you',
  running: 'Running',
  open: 'Open',
  done: 'Done',
}

export interface ThreadSession {
  session: Session
  /** 0 for the root; a fork is one deeper than the session it was forked from. */
  depth: number
}

export interface SessionThreadView {
  /** The tree flattened in reading order: the root, each session followed by its forks (oldest first). */
  sessions: ThreadSession[]
  branches: string[]
  pulls: PullRef[]
  artifacts: Artifact[]
  state: ThreadState
}

export function upsertSession(list: Session[], s: Session): Session[] {
  return list.some(x => x.id === s.id) ? list.map(x => (x.id === s.id ? s : x)) : [s, ...list]
}

/** The thread `sessionId` sits in, built from the project's sessions (which must include it), or null. */
export function threadOfSession(
  sessions: Session[],
  artifacts: Artifact[],
  sessionId: string,
): SessionThreadView | null {
  const byId = new Map(sessions.map(s => [s.id, s]))
  let root = byId.get(sessionId)
  if (!root) return null
  const seen = new Set<string>()
  while (root.parentId && byId.has(root.parentId) && !seen.has(root.id)) {
    seen.add(root.id)
    root = byId.get(root.parentId)!
  }
  const children = new Map<string, Session[]>()
  for (const s of sessions) {
    if (!s.parentId) continue
    const list = children.get(s.parentId) ?? []
    list.push(s)
    children.set(s.parentId, list)
  }
  const flat: ThreadSession[] = []
  const visited = new Set<string>()
  const walk = (s: Session, depth: number) => {
    if (visited.has(s.id)) return
    visited.add(s.id)
    flat.push({ session: s, depth })
    const kids = (children.get(s.id) ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const k of kids) walk(k, depth + 1)
  }
  walk(root, 0)

  const branches: string[] = []
  const pulls = new Map<number, PullRef>()
  for (const { session: s } of flat) {
    const branch = s.workspace.kind === 'worktree' ? s.workspace.branch : s.branch
    if (branch && !branches.includes(branch)) branches.push(branch)
    if (s.pull && !pulls.has(s.pull.number)) pulls.set(s.pull.number, s.pull)
  }
  const pullList = [...pulls.values()].sort((a, b) => a.number - b.number)
  const all = flat.map(t => t.session)
  const state: ThreadState = all.some(s => s.state === 'waiting')
    ? 'needs-you'
    : all.some(s => s.state === 'running')
      ? 'running'
      : pullList.some(p => p.merged)
        ? 'done'
        : 'open'
  const artifactById = new Map<Artifact['id'], Artifact>()
  for (const a of artifacts) if (visited.has(a.sessionId)) artifactById.set(a.id, a)
  return {
    sessions: flat,
    branches,
    pulls: pullList,
    artifacts: [...artifactById.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    state,
  }
}
