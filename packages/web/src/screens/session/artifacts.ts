// The artifact column's rules, kept apart from the components so they can be tested on their own.
import type { Artifact } from '@odin/shared/api'

/** Tabs run in the order the artifacts were posted. */
export function artifactOrder(list: readonly Artifact[]): Artifact[] {
  return [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id)
}

/** The column opens on the newest artifact. */
export function newestArtifact(list: readonly Artifact[]): Artifact | null {
  return artifactOrder(list).at(-1) ?? null
}

/** A tab label short enough for the column header; the full title stays in the frame's title. */
export function tabLabel(title: string, max = 28): string {
  const t = title.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/** Every version the picker can step through: what the server listed, the latest, and the one on show. */
export function versionNumbers(listed: readonly number[], latest: number, shown: number): number[] {
  return [...new Set([...listed, latest, shown])].sort((a, b) => a - b)
}
