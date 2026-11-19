import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import ProjectContextPanel from './ProjectContextPanel.vue'

const mounted: { unmount(): void }[] = []
afterEach(() => {
  mounted.splice(0).forEach(w => w.unmount())
  document.body.innerHTML = ''
})

async function mountPanel(api = createMockApi()) {
  const m = await mountProjectScreen(ProjectContextPanel, '/p/odin/library', api, 'odin')
  mounted.push(m.wrapper)
  for (let i = 0; i < 4; i++) await flushPromises()
  return { ...m, api }
}

describe('ProjectContextPanel', () => {
  it('lists project files and global items, and turns a global item off', async () => {
    const { wrapper, api } = await mountPanel()
    expect(wrapper.text()).toContain('Ship')
    expect(wrapper.text()).toContain('Notes')
    await wrapper.get('button[role="switch"]').trigger('click')
    await flushPromises()
    const view = await api.getAgentContext('odin')
    expect(view.global.find(item => item.id === 'notes')?.enabled).toBe(false)
  })

  it('adds a project skill', async () => {
    const { wrapper, api } = await mountPanel()
    const add = wrapper.findAll('button').find(b => b.text().trim() === 'Skill')
    expect(add).toBeTruthy()
    await add!.trigger('click')
    await flushPromises()
    await wrapper.get('input').setValue('triage')
    await wrapper
      .get('textarea')
      .setValue('---\nname: triage\ndescription: Sort bugs.\n---\nSort them.\n')
    const save = wrapper.findAll('button').find(b => b.text().trim() === 'Save')
    expect(save).toBeTruthy()
    await save!.trigger('click')
    await flushPromises()
    const view = await api.getAgentContext('odin')
    expect(view.project.some(item => item.kind === 'skill' && item.id === 'triage')).toBe(true)
  })
})
