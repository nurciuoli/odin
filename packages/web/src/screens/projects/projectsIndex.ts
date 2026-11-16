// /projects: filter and order the project cards, count open PRs per project.
import type { ProjectSummary, Session } from '@odin/shared/api'

const activityOf = (p: Pick<ProjectSummary, 'activity'>) =>
  (p.activity ?? []).reduce((t, n) => t + n, 0)

/** Matching name, title, description or repo (case-insensitive); most sessions in the last 14 days first. */
export function sortProjects<T extends ProjectSummary>(projects: T[], filter = ''): T[] {
  const q = filter.trim().toLowerCase()
  return projects
    .filter(
      p =>
        !q || [p.name, p.title, p.description, p.repo ?? ''].some(s => s.toLowerCase().includes(q)),
    )
    .slice()
    .sort(
      (a, b) =>
        activityOf(b) - activityOf(a) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.title.localeCompare(b.title),
    )
}

/** Distinct open PRs per project, from sessions' `pull`. */
export function openPullCounts(sessions: Pick<Session, 'project' | 'pull'>[]): Map<string, number> {
  const seen = new Map<string, Set<number>>()
  for (const s of sessions) {
    if (s.pull?.state !== 'open' || s.pull.merged) continue
    const set = seen.get(s.project) ?? new Set<number>()
    set.add(s.pull.number)
    seen.set(s.project, set)
  }
  return new Map([...seen].map(([k, v]) => [k, v.size]))
}
