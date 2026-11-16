// Related projects: the other entries of `projects[]` across a project's sessions, most frequent first.
import type { Session } from '@odin/shared/api'

export interface RelatedProject {
  name: string
  /** Sessions of this project that also include it. */
  count: number
}

export function relatedProjects(
  project: string,
  sessions: Pick<Session, 'project' | 'projects'>[],
): RelatedProject[] {
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const names = new Set(s.projects?.length ? s.projects : [s.project])
    if (!names.has(project)) continue
    for (const n of names) if (n !== project) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/**
 * The first section of a markdown doc: a leading `#` title, any intro, and the first section after it; it ends where
 * the next section starts. `more` says whether anything was cut.
 */
export function firstSection(markdown: string): { excerpt: string; more: boolean } {
  const lines = markdown.split('\n')
  const firstText = lines.findIndex(l => l.trim())
  const heads = lines
    .map((l, i) => (/^#{1,6}\s/.test(l) ? i : -1))
    .filter(i => i >= 0 && i !== firstText)
  const cut = heads[1]
  if (cut === undefined) return { excerpt: markdown.trim(), more: false }
  return { excerpt: lines.slice(0, cut).join('\n').trim(), more: true }
}
