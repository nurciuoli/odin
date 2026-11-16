// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMockApi } from '@/api/mock'
import { formFromProject, RESET_REQUEST, settingsChanges, validateSettings } from './settingsForm'

const project = () => createMockApi().getProject('odin')

describe('project settings form', () => {
  it('starts from the effective settings with nothing to save', async () => {
    const p = await project()
    const form = formFromProject(p)
    expect(form.title).toBe(p.settings.title)
    expect(settingsChanges(form, p)).toBeNull()
  })

  it('sends only what changed, and null to clear the repo', async () => {
    const p = await project()
    const form = formFromProject(p)
    form.title = '  Odin 2 '
    form.repo = ''
    expect(settingsChanges(form, p)).toEqual({ title: 'Odin 2', repo: null })
  })

  it('sends the whole commands object when one command changes, without empty ones', async () => {
    const p = await project()
    const form = formFromProject(p)
    form.install = 'pnpm i'
    form.build = ''
    const req = settingsChanges(form, p)!
    expect(req.commands).toMatchObject({ install: 'pnpm i' })
    expect(req.commands).not.toHaveProperty('build')
  })

  it('validates title, repo and branch', async () => {
    const form = formFromProject(await project())
    expect(validateSettings({ ...form, title: ' ', repo: 'nope', defaultBranch: '' })).toEqual({
      title: 'Give the project a title.',
      repo: 'Use owner/name, like nurciuoli/odin.',
      defaultBranch: 'Name the default branch.',
    })
    expect(validateSettings(form)).toEqual({})
  })

  it('resets every override with null', () => {
    expect(Object.values(RESET_REQUEST).every(v => v === null)).toBe(true)
  })
})
