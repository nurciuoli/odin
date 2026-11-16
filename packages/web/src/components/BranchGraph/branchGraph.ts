import type { GraphBranch } from './types'

export const STEP = 32
export const ROW = 32
export const PAD = 12

export const xOf = (order: number) => PAD + order * STEP
export const yOf = (lane: number) => lane * ROW + ROW / 2

/** Last x order the graph uses (merge points count one step past the branch). */
export function extent(branches: GraphBranch[]): number {
  let max = 1
  for (const b of branches) {
    const len = Math.max(1, b.length)
    max = Math.max(max, b.forkAt + len + (b.end === 'merged' ? 1 : 0))
    for (const m of b.marks) max = Math.max(max, m.at)
  }
  return max
}

/** SVG path of branch `lane` (1-based; the trunk is lane 0). */
export function branchPath(b: GraphBranch, lane: number): string {
  const f = b.forkAt
  const len = Math.max(1, b.length)
  const yT = yOf(0)
  const yB = yOf(lane)
  const h = STEP / 2
  let d = `M${xOf(f)} ${yT} C${xOf(f) + h} ${yT} ${xOf(f) + h} ${yB} ${xOf(f + 1)} ${yB}`
  if (len > 1) d += ` L${xOf(f + len)} ${yB}`
  if (b.end === 'merged') {
    const e = xOf(f + len)
    d += ` C${e + h} ${yB} ${e + h} ${yT} ${xOf(f + len + 1)} ${yT}`
  }
  return d
}

const END_WORD = { merged: 'merged', open: 'open', none: '' } as const

/** One line of text for a branch, for the narrow list and assistive tech. */
export function branchSummary(b: GraphBranch): string {
  const parts = [END_WORD[b.end ?? 'none'], b.dashed ? 'stale' : ''].filter(Boolean)
  return parts.length ? `${b.name} (${parts.join(', ')})` : b.name
}
