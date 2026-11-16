// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildCreateRequest,
  emptyForm,
  nameFromPath,
  needsGitInit,
  validateAddProject,
} from './addProjectForm'

describe('add project form', () => {
  it('derives a name from the folder', () => {
    expect(nameFromPath('/work/Atlas Project/')).toBe('atlas-project')
    expect(nameFromPath('')).toBe('')
  })

  it('needs an absolute path and a well-formed name when one is given', () => {
    expect(validateAddProject(emptyForm()).path).toBe('Enter the folder path.')
    expect(validateAddProject({ ...emptyForm(), path: 'work/a' }).path).toContain('absolute')
    expect(validateAddProject({ ...emptyForm(), path: '/work/a' })).toEqual({})
    expect(validateAddProject({ path: '/work/a', name: 'Bad Name', init: false }).name).toContain(
      'Lowercase',
    )
  })

  it('builds the request without empty fields', () => {
    expect(buildCreateRequest({ path: ' /work/a ', name: '', init: false })).toEqual({
      path: '/work/a',
    })
    expect(buildCreateRequest({ path: '/work/a', name: 'a', init: true })).toEqual({
      path: '/work/a',
      name: 'a',
      init: true,
    })
  })

  it('recognises the not-a-repo refusal', () => {
    expect(needsGitInit('/work/a is not a git repository (pass init to create one)')).toBe(true)
    expect(needsGitInit('Project "rick" already exists')).toBe(false)
  })
})
