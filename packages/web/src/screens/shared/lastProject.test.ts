import { beforeEach, describe, expect, it } from 'vitest'
import { initialProjects, rememberProject } from './lastProject'

describe('lastProject', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to the first project when nothing is remembered', () => {
    expect(initialProjects(['a', 'b'])).toEqual({ project: 'a', projects: ['a'] })
    expect(initialProjects([])).toBeUndefined()
  })

  it('restores the last used project and its selection', () => {
    rememberProject('b', ['a', 'b'])
    expect(initialProjects(['a', 'b', 'c'])).toEqual({ project: 'b', projects: ['a', 'b'] })
  })

  it('falls back to the first project when the remembered one is gone', () => {
    rememberProject('gone', ['gone'])
    expect(initialProjects(['a', 'b'])).toEqual({ project: 'a', projects: ['a'] })
  })

  it('drops removed projects from the remembered selection', () => {
    rememberProject('b', ['a', 'b'])
    expect(initialProjects(['b', 'c'])).toEqual({ project: 'b', projects: ['b'] })
  })

  it('survives corrupt storage', () => {
    localStorage.setItem('odin:last-project', '{nope')
    expect(initialProjects(['a'])).toEqual({ project: 'a', projects: ['a'] })
  })
})
