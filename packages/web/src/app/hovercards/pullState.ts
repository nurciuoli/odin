// A pull request's state as the Details header shows it: the glyph carries the state, so it needs a name for
// screen readers and the hover card, an icon, and a colour.
import type { PullRef } from '@odin/shared/api'
import type { IconName } from '@/components/Icon'

export type PullTone = 'open' | 'merged' | 'closed'

export const PULL_STATE: Record<PullTone, { label: string; icon: IconName }> = {
  open: { label: 'Open', icon: 'gitPullRequest' },
  merged: { label: 'Merged', icon: 'gitMerge' },
  closed: { label: 'Closed', icon: 'gitPullRequestClosed' },
}

export function pullTone(pr: PullRef): PullTone {
  return pr.merged ? 'merged' : pr.state
}
