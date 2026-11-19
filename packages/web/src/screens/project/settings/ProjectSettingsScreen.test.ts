import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import ProjectSettingsScreen from './ProjectSettingsScreen.vue'

const mountSettings = (project = 'odin', api = createMockApi()) =>
  mountProjectScreen(ProjectSettingsScreen, `/p/${project}/settings`, api, project)

type Wrapper = Awaited<ReturnType<typeof mountSettings>>['wrapper']
// Click a row's value to edit it, type, and press Enter.
async function edit(wrapper: Wrapper, label: string, value: string, key = 'Enter') {
  await wrapper.find(`button[aria-label="Edit ${label}"]`).trigger('click')
  const input = wrapper.find('input.sheet-row__input, textarea.sheet-row__input')
  await input.setValue(value)
  await input.trigger('keydown', { key })
  await flushPromises()
}

describe('ProjectSettingsScreen', () => {
  it('shows the effective settings as rows', async () => {
    const { wrapper } = await mountSettings()
    await flushPromises()
    expect(wrapper.find('button[aria-label="Edit Title"]').text()).toBe('Odin')
    expect(wrapper.text()).toContain('Claude Code')
    expect(wrapper.text()).not.toContain('Save changes')
  })

  it('saves one field when Enter is pressed, and only that field', async () => {
    const { api, wrapper } = await mountSettings()
    await flushPromises()
    const spy = vi.spyOn(api, 'updateProjectSettings')
    await edit(wrapper, 'Title', 'Odin 2')
    expect(spy).toHaveBeenCalledWith('odin', { title: 'Odin 2' })
  })

  it('Esc cancels without saving, and an unchanged value does not save', async () => {
    const { api, wrapper } = await mountSettings()
    await flushPromises()
    const spy = vi.spyOn(api, 'updateProjectSettings')
    await edit(wrapper, 'Title', 'Changed', 'Escape')
    expect(wrapper.find('button[aria-label="Edit Title"]').text()).toBe('Odin')
    await edit(wrapper, 'Title', 'Odin')
    expect(spy).not.toHaveBeenCalled()
  })

  it('clears the repo with an empty value and refuses an invalid one', async () => {
    const { api, wrapper } = await mountSettings()
    await flushPromises()
    const spy = vi.spyOn(api, 'updateProjectSettings')
    await edit(wrapper, 'GitHub repo', 'not a repo')
    expect(wrapper.text()).toContain('Use owner/name')
    expect(spy).not.toHaveBeenCalled()
    const input = wrapper.find('input.sheet-row__input')
    await input.setValue('')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(spy).toHaveBeenCalledWith('odin', { repo: null })
  })

  it('sends the whole commands object when one command changes', async () => {
    const { api, wrapper } = await mountSettings()
    await flushPromises()
    const spy = vi.spyOn(api, 'updateProjectSettings')
    await edit(wrapper, 'Build', 'npm run build')
    expect(spy).toHaveBeenCalledWith('odin', {
      commands: expect.objectContaining({ build: 'npm run build' }),
    })
  })

  it('saves the sources with the edited list', async () => {
    const { api, wrapper } = await mountSettings()
    await flushPromises()
    const spy = vi.spyOn(api, 'updateProjectSources')
    await edit(wrapper, 'Status', 'docs/STATUS.md, docs/NOW.md')
    expect(spy).toHaveBeenCalledWith(
      'odin',
      expect.objectContaining({ status: ['docs/STATUS.md', 'docs/NOW.md'] }),
    )
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
