// Mock run tree for the branch-per-agent mockups. The main session is the trunk; subagents and processes fork off
// it (or off another subagent) and their branch grows for as long as they run.
export type NodeKind = 'subagent' | 'process'
export type NodeState = 'pending' | 'running' | 'waiting' | 'done' | 'failed'

interface Spec {
  id: string
  parent: string
  kind: NodeKind
  name: string
  start: number
  /** undefined: still going at the end of the clip (a dev server, say) */
  end?: number
  result?: 'done' | 'failed'
  pause?: [number, number]
  running: string
  waiting?: string
  final: string
}

export const LOOP = 34
export const SECONDS_SHOWN = 34

// depth-first, siblings by start time: the order a git log would print them
const specs: Spec[] = [
  { id: 'explorer', parent: 'main', kind: 'subagent', name: 'explorer', start: 0, end: 9, result: 'done', running: 'Reading middleware', final: '14 call sites found' },
  { id: 'grep', parent: 'explorer', kind: 'subagent', name: 'grep-sweep', start: 3, end: 7, result: 'done', running: 'Searching src/', final: '31 matches' },
  { id: 'reviewer', parent: 'main', kind: 'subagent', name: 'reviewer', start: 1, end: 22, result: 'done', pause: [6, 13], running: 'Reading the diff', waiting: 'Wants to run git fetch', final: 'No blockers found' },
  { id: 'tests', parent: 'main', kind: 'subagent', name: 'test-runner', start: 2, end: 16, result: 'failed', running: 'Running tests', final: '3 tests failed' },
  { id: 'yarn', parent: 'tests', kind: 'process', name: 'yarn test', start: 4, end: 16, result: 'failed', running: 'core: 212 passed', final: 'exit 1' },
  { id: 'docs', parent: 'main', kind: 'subagent', name: 'docs', start: 9, end: 17, result: 'done', running: 'Writing the entry', final: 'Wrote changes/feat-x.md' },
  { id: 'migrator', parent: 'main', kind: 'subagent', name: 'migrator', start: 12, end: 26, result: 'done', running: 'Checking schema', final: 'Schema is current' },
  { id: 'dev', parent: 'migrator', kind: 'process', name: 'yarn dev:core', start: 14, running: 'Listening on :8791', final: 'Listening on :8791' },
]

export interface TreeNode {
  id: string
  parent: string
  depth: number
  row: number
  kind: NodeKind
  name: string
  state: NodeState
  start: number
  /** seconds the branch has grown so far */
  len: number
  note: string
  /** column in the gutter of the log layout */
  lane: number
}

const depthOf = (id: string): number => (id === 'main' ? 0 : depthOf(specs.find((s) => s.id === id)!.parent) + 1)

// lanes for the gutter: lowest free column from 1, held until the branch has ended
const laneOf = new Map<string, number>()
{
  const byStart = [...specs].sort((a, b) => a.start - b.start)
  const busy: { lane: number; until: number }[] = []
  for (const s of byStart) {
    let lane = 1
    while (busy.some((b) => b.lane === lane && b.until > s.start - 1.5)) lane++
    busy.push({ lane, until: s.end ?? Infinity })
    laneOf.set(s.id, lane)
  }
}

export function nodesAt(time: number): TreeNode[] {
  const t = ((time % LOOP) + LOOP) % LOOP
  return specs.map((s, row) => {
    const base = { id: s.id, parent: s.parent, depth: depthOf(s.id), row, kind: s.kind, name: s.name, start: s.start, lane: laneOf.get(s.id)! }
    const age = t - s.start
    if (age < 0) return { ...base, state: 'pending', len: 0, note: '' }
    if (s.end !== undefined && t >= s.end) return { ...base, state: s.result!, len: s.end - s.start, note: s.final }
    if (s.pause && age >= s.pause[0] && age < s.pause[1]) return { ...base, state: 'waiting', len: s.pause[0], note: s.waiting ?? 'Waiting on you' }
    const lost = s.pause && age >= s.pause[1] ? s.pause[1] - s.pause[0] : 0
    return { ...base, state: 'running', len: age - lost, note: s.running }
  })
}

export const rowCount = specs.length + 1 // plus the trunk
export const stateWord: Record<NodeState, string> = { pending: 'Queued', running: 'Working', waiting: 'Waiting on you', done: 'Returned', failed: 'Failed' }
export const stateColor: Record<NodeState, string> = {
  pending: 'var(--iu-text-disabled)',
  running: 'var(--iu-info)',
  waiting: 'var(--iu-warning)',
  done: 'var(--iu-positive)',
  failed: 'var(--iu-danger)',
}
export const parentRow = (n: TreeNode, all: TreeNode[]) => (n.parent === 'main' ? -1 : all.find((x) => x.id === n.parent)!.row)

export function summary(all: TreeNode[]): string {
  const c = (s: NodeState) => all.filter((n) => n.state === s).length
  return `${c('running')} working, ${c('waiting')} waiting on you, ${c('done')} returned, ${c('failed')} failed`
}
export const elapsed = (n: TreeNode) => `${Math.round(n.len)}s`
