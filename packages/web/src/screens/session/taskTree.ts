// The background-task tree: subagents and commands as branches of the session. Pure functions over the task entries
// the Activity list already reads, so the Lanes and the Strip draw the same shape from one definition.
import type { TaskActivity } from '@odin/shared/harness'
import { taskKey } from '@odin/shared/harness'
import { activityLabel, taskStateLabel } from './activity'

export type TreeState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown'

export interface TreeNode {
  id: string
  label: string
  kind: 'agent' | 'command'
  state: TreeState
  stateLabel: string
  /** epoch ms */
  start: number
  /** epoch ms; null while it runs */
  end: number | null
  depth: number
  /** id of the task that started it; null: it hangs off the session itself */
  parent: string | null
  summary?: string
}

const STATE: Record<TaskActivity['state'], TreeState> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
  unknown: 'unknown',
}

const time = (iso: string | null | undefined) => {
  const ms = iso ? Date.parse(iso) : NaN
  return Number.isFinite(ms) ? ms : null
}

/** Depth first, siblings by start time: the order a `git log --graph` would print them. */
export function buildTaskTree(tasks: TaskActivity[], now: number): TreeNode[] {
  let last = now
  const starts = tasks.map(t => (last = time(t.startedAt) ?? time(t.observedAt) ?? last))
  const byTool = new Map<string, number>()
  tasks.forEach((t, i) => t.toolUseId && byTool.set(t.toolUseId, i))
  const parentOf = tasks.map((t, i) => {
    const p = t.parentToolUseId ? byTool.get(t.parentToolUseId) : undefined
    return p === undefined || p === i ? -1 : p
  })
  const kids = new Map<number, number[]>()
  tasks.forEach((_, i) => kids.set(parentOf[i], [...(kids.get(parentOf[i]) ?? []), i]))
  const out: TreeNode[] = []
  const seen = new Set<number>()
  const walk = (i: number, depth: number) => {
    if (seen.has(i)) return
    seen.add(i)
    const t = tasks[i]
    out.push({
      id: taskKey(t),
      label: activityLabel(t),
      kind: t.kind,
      state: STATE[t.state],
      stateLabel: taskStateLabel(t),
      start: starts[i],
      end: time(t.completedAt),
      depth,
      parent: parentOf[i] < 0 ? null : taskKey(tasks[parentOf[i]]),
      summary: t.summary,
    })
    for (const k of [...(kids.get(i) ?? [])].sort((a, b) => starts[a] - starts[b]))
      walk(k, depth + 1)
  }
  for (const r of [...(kids.get(-1) ?? [])].sort((a, b) => starts[a] - starts[b])) walk(r, 0)
  // a parent cycle would leave tasks unreached: show them as roots rather than lose them
  tasks.forEach((_, i) => walk(i, 0))
  return out
}

/** Most recent rows when there are many; `hidden` says how many earlier ones were left out. */
export function limitRows(nodes: TreeNode[], max: number): { shown: TreeNode[]; hidden: number } {
  if (nodes.length <= max) return { shown: nodes, hidden: 0 }
  return { shown: nodes.slice(nodes.length - max), hidden: nodes.length - max }
}

export function spanLabel(n: TreeNode, now: number): string {
  const seconds = Math.max(0, Math.floor(((n.end ?? now) - n.start) / 1000))
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  return m < 60 ? `${m}m ${seconds % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export interface Placed {
  node: TreeNode
  /** where it forks off */
  x0: number
  /** where its branch ends (the head) */
  x1: number
  y: number
  /** y of the lane it forks from: the session trunk or its parent */
  fromY: number
}

/**
 * Shortest time scale the graph will use. A run younger than this draws on a five-minute window, so a branch that
 * just started sits at the left and its head moves right as it works. Once the work is older, the scale grows to
 * fit it.
 */
export const TREE_START_WINDOW_MS = 5 * 60 * 1000

/** x is time, scaled so the whole session fits `width`; a branch is never shorter than `min` px. */
export function placeTree(
  nodes: TreeNode[],
  now: number,
  o: { width: number; row: number; min: number; pad: number },
): { placed: Placed[]; trunkEnd: number; height: number } {
  const t0 = Math.min(now, ...nodes.map(n => n.start))
  const t1 = Math.max(now, ...nodes.map(n => n.end ?? now))
  const span = Math.max(TREE_START_WINDOW_MS, t1 - t0)
  const inner = o.width - o.pad * 2
  const x = (ms: number) => o.pad + ((ms - t0) / span) * inner
  const rowOf = new Map(nodes.map((n, i) => [n.id, i]))
  const placed = nodes.map((node, i) => {
    const x0 = x(node.start)
    const parentRow = node.parent === null ? undefined : rowOf.get(node.parent)
    return {
      node,
      x0,
      x1: Math.min(o.width - o.pad, Math.max(x0 + o.min, x(node.end ?? now))),
      y: (i + 1) * o.row + o.row / 2,
      fromY: parentRow === undefined ? o.row / 2 : (parentRow + 1) * o.row + o.row / 2,
    }
  })
  return { placed, trunkEnd: x(now), height: (nodes.length + 1) * o.row }
}

export const STATE_COUNT = (nodes: TreeNode[], s: TreeState) =>
  nodes.filter(n => n.state === s).length
