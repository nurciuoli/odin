// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildNewProjectRequest,
  effectiveName,
  emptyNewProject,
  joinPath,
  nameFromPath,
  nameFromSource,
  plan,
  recentParents,
  targetPath,
  validateNewProject,
} from './newProjectForm'

const fresh = (over = {}) => ({ ...emptyNewProject('new', '/home/me/code'), ...over })

describe('new project form', () => {
  it('derives names from folders and repositories', () => {
    expect(nameFromPath('/work/Atlas Project/')).toBe('atlas-project')
    expect(nameFromSource('nurciuoli/odin')).toBe('odin')
    expect(nameFromSource('https://github.com/acme/Harbor-API.git')).toBe('harbor-api')
    expect(nameFromSource('git@github.com:acme/rick.git')).toBe('rick')
  })

  it('joins paths with the separator the parent uses', () => {
    expect(joinPath('/home/me/code', 'a')).toBe('/home/me/code/a')
    expect(joinPath('/home/me/code/', 'a')).toBe('/home/me/code/a')
    expect(joinPath('C:\\code', 'a')).toBe('C:\\code\\a')
  })

  it('builds a new-folder request that makes the folder, README and git', () => {
    const f = fresh({ name: 'notes', readme: true })
    expect(targetPath(f)).toBe('/home/me/code/notes')
    expect(buildNewProjectRequest(f)).toEqual({
      path: '/home/me/code/notes',
      name: 'notes',
      mkdir: true,
      readme: true,
      init: true,
    })
    expect(plan(f)).toEqual([
      'mkdir /home/me/code/notes',
      'write README.md',
      'git init (no commit)',
      'add as a project',
    ])
  })

  it('builds an existing-folder request that follows the folder name', () => {
    const f = { ...emptyNewProject('existing'), path: ' /work/Atlas ', init: false }
    expect(effectiveName(f)).toBe('atlas')
    expect(buildNewProjectRequest(f)).toEqual({ path: '/work/Atlas', name: 'atlas' })
  })

  it('builds a clone request named after the repository', () => {
    const f = fresh({ mode: 'clone', source: 'nurciuoli/odin-site' })
    expect(buildNewProjectRequest(f)).toEqual({
      path: '/home/me/code/odin-site',
      name: 'odin-site',
      clone: 'nurciuoli/odin-site',
    })
  })

  it('validates each mode', () => {
    expect(validateNewProject(fresh()).name).toBe('Give it a name.')
    expect(validateNewProject(fresh({ name: 'Bad Name' })).name).toContain('Lowercase')
    expect(validateNewProject(fresh({ name: 'ok', parent: '' })).parent).toBe(
      'Choose where it goes.',
    )
    expect(validateNewProject(fresh({ name: 'ok' }))).toEqual({})
    expect(validateNewProject({ ...emptyNewProject('existing'), path: 'rel/dir' }).path).toContain(
      'absolute',
    )
    expect(validateNewProject(fresh({ mode: 'clone', source: 'not a url' })).source).toBe(
      'Use owner/name, an https:// or ssh:// URL, or git@host:path.',
    )
    expect(validateNewProject(fresh({ mode: 'clone', source: 'git@github.com:a/b.git' }))).toEqual(
      {},
    )
  })

  it('suggests the folders your projects already sit in, most used first', () => {
    expect(recentParents(['/c/a', '/c/b', '/w/x', '/c/d', '/w/y', '/z'])).toEqual(['/c', '/w'])
  })
})
