const key = 'odin:last-project'

export interface LastProject {
  project: string
  projects: string[]
}

/** The working project and the projects last picked in a composer. */
export function lastProject(): LastProject | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!value || typeof value.project !== 'string' || !value.project) return undefined
    const projects: unknown[] = Array.isArray(value.projects) ? value.projects : []
    return { project: value.project, projects: projects.filter(p => typeof p === 'string') }
  } catch {
    return undefined
  }
}

export function rememberProject(project: string, projects: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify({ project, projects }))
  } catch {
    // Storage can be unavailable; the composer falls back to the first project.
  }
}

/** The remembered selection limited to projects that still exist, or the first available project. */
export function initialProjects(available: string[]): LastProject | undefined {
  const last = lastProject()
  if (last && available.includes(last.project)) {
    const projects = last.projects.filter(p => available.includes(p))
    if (!projects.includes(last.project)) projects.unshift(last.project)
    return { project: last.project, projects }
  }
  const first = available[0]
  return first ? { project: first, projects: [first] } : undefined
}
