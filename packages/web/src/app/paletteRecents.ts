// What the palette's empty state offers under "Recent": the last few sessions, projects and files you opened from it,
// newest first, kept in localStorage so a reload keeps them. Items are stored as the palette shows them.
import type { IconName } from '@/components/Icon'

export interface RecentEntry {
  id: string
  label: string
  icon?: IconName
  detail?: string
  hint?: string
}

const KEY = 'odin:palette-recent'
export const RECENT_LIMIT = 6

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadRecents(): RecentEntry[] {
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (e): e is RecentEntry => !!e && typeof e.id === 'string' && typeof e.label === 'string',
      )
      .slice(0, RECENT_LIMIT)
  } catch {
    return []
  }
}

/** Puts `entry` first (replacing an earlier one with the same id); returns the new list. */
export function pushRecent(entry: RecentEntry): RecentEntry[] {
  const next = [entry, ...loadRecents().filter(e => e.id !== entry.id)].slice(0, RECENT_LIMIT)
  try {
    storage()?.setItem(KEY, JSON.stringify(next))
  } catch {
    // private mode or full: the list simply isn't kept
  }
  return next
}
