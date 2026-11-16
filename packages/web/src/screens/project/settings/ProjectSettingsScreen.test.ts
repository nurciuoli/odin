import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import ProjectSettingsScreen from './ProjectSettingsScreen.vue'

const mountSettings = (project = 'odin', api = createMockApi()) =>
  mountProjectScreen(ProjectSettingsScreen, `/p/${project}/settings`, api, project)

describe('ProjectSettingsScreen', () => {
  it('starts from the effective settings with nothing to save', async () => {
    const { wrapper } = await mountSettings()
    await flushPromises()
    const title = wrapper.find('input[type="text"]').element as HTMLInputElement
    expect(title.value).toBe('Odin')
    expect(wrapper.text()).toContain('All changes saved')
    expect(wrapper.text()).toContain('Claude Code tracking')
  })

  it('saves only what changed, and null clears the repo', async () => {
    const { api, wrapper } = await mountSettings()
    await flushPromises()
    const spy = vi.spyOn(api, 'updateProjectSettings')
    const [title, repo] = wrapper.findAll('input[type="text"]')
    await title!.setValue('Odin 2')
    await repo!.setValue('')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('odin', { title: 'Odin 2', repo: null })
  })

  it('does not save an invalid repo', async () => {
    const { api, wrapper } = await mountSettings()
    await flushPromises()
    const spy = vi.spyOn(api, 'updateProjectSettings')
    await wrapper.findAll('input[type="text"]')[1]!.setValue('not a repo')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.text()).toContain('Use owner/name')
    expect(spy).not.toHaveBeenCalled()
  })

  it('toggles Claude Code tracking', async () => {
    const { api, wrapper } = await mountSettings('rick')
    await flushPromises()
    const label = wrapper.findAll('label').find(l => l.text() === 'Track sessions')!
    const toggle = wrapper
      .findAll('[role="switch"]')
      .find(b => b.attributes('id') === label.attributes('for'))!
    expect(toggle.attributes('aria-checked')).toBe('false')
    await toggle.trigger('click')
    await flushPromises()
    expect((await api.getClaudeCodeTracking('rick')).enabled).toBe(true)
  })

  it('saves the GitHub opt-in', async () => {
    const { api, wrapper } = await mountSettings()
    await flushPromises()
    const save = vi.spyOn(api, 'updateProjectSettings')
    const label = wrapper.findAll('label').find(l => l.text() === 'Enable GitHub integration')!
    await wrapper
      .findAll('[role="switch"]')
      .find(b => b.attributes('id') === label.attributes('for'))!
      .trigger('click')
    await flushPromises()
    expect(save).toHaveBeenCalledWith('odin', { githubEnabled: false })
  })

  it('confirms before removing the project', async () => {
    const { api, router, wrapper } = await mountSettings('rick')
    for (const session of await api.listSessions({ project: 'rick' }))
      await api.deleteSession(session.id)
    await flushPromises()
    await wrapper
      .findAll('button')
      .find(b => b.text().startsWith('Remove project'))!
      .trigger('click')
    expect((await api.listProjects()).map(p => p.name)).toContain('rick')
    const confirm = wrapper.findAll('button').find(b => b.text() === 'Remove')!
    await confirm.trigger('click')
    await flushPromises()
    expect((await api.listProjects()).map(p => p.name)).not.toContain('rick')
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/'), { timeout: 5000 })
  })
})
