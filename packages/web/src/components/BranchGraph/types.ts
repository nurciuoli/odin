import type { RouteLocationRaw } from 'vue-router'

export type BranchIntent = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger'

export interface BranchMark {
  /** Position on the x axis (an order, not a time). */
  at: number
  intent: BranchIntent
  /** Accessible name and tooltip ("Session: Remove Pi, ended"). */
  label: string
  /** Makes the mark a link. */
  to?: RouteLocationRaw
}

export interface GraphBranch {
  name: string
  /** Where it leaves the trunk, on the x axis. */
  forkAt: number
  /** How far it runs from `forkAt` (at least 1). */
  length: number
  intent: BranchIntent
  /** Drawn dashed (stale, abandoned). */
  dashed?: boolean
  /** merged: rejoins the trunk; open: an open end (PR open); none: just stops. */
  end?: 'merged' | 'open' | 'none'
  marks: BranchMark[]
}
