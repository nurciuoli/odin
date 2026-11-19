// The New project dialog as plain data: the three ways to start (new folder, existing folder, clone), the path each
// builds, validation and the request. The dialog is only the view over this.
import type { CreateProjectRequest } from '@odin/shared/api'
import { PROJECT_NAME_PATTERN } from '@odin/shared/labels'

export type NewProjectMode = 'new' | 'existing' | 'clone'

export interface NewProjectForm {
  mode: NewProjectMode
  /** The folder name for `new` and `clone`; the project name for `existing` (empty: follow the folder). */
  name: string
  /** Where the folder goes (`new`, `clone`). */
  parent: string
  /** The folder itself (`existing`). */
  path: string
  /** `owner/name` or a URL (`clone`). */
  source: string
  init: boolean
  readme: boolean
}

export type NewProjectErrors = Partial<Record<'name' | 'parent' | 'path' | 'source', string>>

export const emptyNewProject = (mode: NewProjectMode = 'new', parent = ''): NewProjectForm => ({
  mode,
  name: '',
  parent,
  path: '',
  source: '',
  init: true,
  readme: false,
})

/** The last folder of an absolute path, lower-cased and dashed into something that fits PROJECT_NAME_PATTERN. */
export function nameFromPath(path: string): string {
  const folder =
    path
      .trim()
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() ?? ''
  return folder
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

const ABSOLUTE = /^(\/|~(\/|$)|[A-Za-z]:[\\/]|\\\\)/

/** `parent` + `name`, joined with the separator `parent` already uses. */
export function joinPath(parent: string, name: string): string {
  const p = parent.trim()
  if (!p) return name
  const sep = p.includes('\\') && !p.includes('/') ? '\\' : '/'
  return p.endsWith('/') || p.endsWith('\\') ? p + name : p + sep + name
}

/** A repository's folder name: the last segment of `owner/name` or a URL, without `.git`. */
export function nameFromSource(source: string): string {
  const last =
    source
      .trim()
      .replace(/\.git$/i, '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/:]/)
      .pop() ?? ''
  return nameFromPath(last)
}

const SOURCE = /^([\w.-]+\/[\w.-]+|https:\/\/\S+|ssh:\/\/\S+|git@[\w.-]+:\S+)$/

/** The name the project and folder will have, from what's typed or, failing that, from the other fields. */
export function effectiveName(f: NewProjectForm): string {
  const typed = f.name.trim()
  if (typed) return typed
  if (f.mode === 'existing') return nameFromPath(f.path)
  if (f.mode === 'clone') return nameFromSource(f.source)
  return ''
}

/** The folder the project will live in. */
export function targetPath(f: NewProjectForm): string {
  if (f.mode === 'existing') return f.path.trim()
  const name = effectiveName(f)
  return name ? joinPath(f.parent, name) : ''
}

export function validateNewProject(f: NewProjectForm): NewProjectErrors {
  const e: NewProjectErrors = {}
  const name = effectiveName(f)
  if (f.mode === 'existing') {
    const path = f.path.trim()
    if (!path) e.path = 'Enter the folder path.'
    else if (!ABSOLUTE.test(path)) e.path = 'Use an absolute path, such as /home/you/my-app.'
  } else {
    if (!f.parent.trim()) e.parent = 'Choose where it goes.'
    else if (!ABSOLUTE.test(f.parent.trim())) e.parent = 'Use an absolute path.'
  }
  if (f.mode === 'clone' && !SOURCE.test(f.source.trim()))
    e.source = 'Use owner/name, an https:// or ssh:// URL, or git@host:path.'
  if (f.mode !== 'existing' && !name) e.name = 'Give it a name.'
  else if (name && !PROJECT_NAME_PATTERN.test(name))
    e.name = 'Lowercase letters, digits and dashes, up to 40 characters.'
  return e
}

export function buildNewProjectRequest(f: NewProjectForm): CreateProjectRequest {
  const req: CreateProjectRequest = { path: targetPath(f) }
  const name = effectiveName(f)
  if (name) req.name = name
  if (f.mode === 'new') {
    req.mkdir = true
    if (f.readme) req.readme = true
    if (f.init) req.init = true
  } else if (f.mode === 'clone') {
    req.clone = f.source.trim()
  } else if (f.init) {
    req.init = true
  }
  return req
}

/** What pressing Create will do, one line per step, for the preview under the form. */
export function plan(f: NewProjectForm): string[] {
  const path = targetPath(f)
  if (!path) return []
  const steps: string[] = []
  if (f.mode === 'clone') steps.push(`git clone ${f.source.trim() || '…'}`)
  else if (f.mode === 'new') steps.push(`mkdir ${path}`)
  if (f.mode === 'new' && f.readme) steps.push('write README.md')
  if (f.mode !== 'clone' && f.init) steps.push('git init (no commit)')
  steps.push(
    f.mode === 'clone' || f.mode === 'new' ? 'add as a project' : `add ${path} as a project`,
  )
  return steps
}

/** The parent folders of the registered projects, most used first: the places you keep projects. */
export function recentParents(paths: string[], limit = 3): string[] {
  const counts = new Map<string, number>()
  for (const p of paths) {
    const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
    if (cut <= 0) continue
    const parent = p.slice(0, cut)
    counts.set(parent, (counts.get(parent) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([p]) => p)
}
