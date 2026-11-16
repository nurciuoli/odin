// The Add project form as plain data: validation and the request it builds.
import type { CreateProjectRequest } from '@odin/shared/api'
import { PROJECT_NAME_PATTERN } from '@odin/shared/labels'

export interface AddProjectForm {
  path: string
  name: string
  init: boolean
}

export type AddProjectErrors = Partial<Record<'path' | 'name', string>>

export const emptyForm = (): AddProjectForm => ({ path: '', name: '', init: false })

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

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/

/** The name is optional (the server slugs the folder name); when given it has to fit the pattern. */
export function validateAddProject(f: AddProjectForm): AddProjectErrors {
  const errors: AddProjectErrors = {}
  const path = f.path.trim()
  if (!path) errors.path = 'Enter the folder path.'
  else if (!ABSOLUTE.test(path))
    errors.path = 'Use an absolute path, such as C:\\projects\\my-app or /home/you/my-app.'
  const name = f.name.trim()
  if (name && !PROJECT_NAME_PATTERN.test(name))
    errors.name = 'Lowercase letters, digits and dashes, up to 40 characters.'
  return errors
}

export function buildCreateRequest(f: AddProjectForm): CreateProjectRequest {
  const req: CreateProjectRequest = { path: f.path.trim() }
  if (f.name.trim()) req.name = f.name.trim()
  if (f.init) req.init = true
  return req
}

/** The server refuses a folder that isn't a repo (400) unless `init` is set. Its message names git. */
export function needsGitInit(message: string): boolean {
  return (
    /\bgit\b/i.test(message) &&
    /(not|isn'?t) (a )?(git )?(repo|repository)|no git|git init/i.test(message)
  )
}
