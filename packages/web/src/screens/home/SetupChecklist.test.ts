import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { ReadinessResponse } from '@odin/shared/api'
import { createMockApi } from '@/api/mock'
import { mountScreen } from '@/screens/shared/testSupport'
import SetupChecklist from './SetupChecklist.vue'

function apiWith(readiness: ReadinessResponse) {
  const api = createMockApi()
  api.getReadiness = async () => readiness
  return api
}

const ok = (id: 'harness' | 'git' | 'projects', label: string) =>
  ({ id, label, state: 'ok', detail: 'fine', fix: null }) as const

describe('SetupChecklist', () => {
  it('stays hidden when everything is ready', async () => {
    const { wrapper } = await mountScreen(SetupChecklist, '/')
    await flushPromises()
    expect(wrapper.text()).toBe('')
  })

  it('stays hidden when only optional features are off', async () => {
    const api = apiWith({
      ready: true,
      checks: [
        ok('harness', 'Agent runtime'),
        {
          id: 'github',
          label: 'GitHub',
          state: 'optional',
          detail: 'No token',
          fix: 'gh auth login',
        },
      ],
    })
    const { wrapper } = await mountScreen(SetupChecklist, '/', api)
    await flushPromises()
    expect(wrapper.text()).toBe('')
  })

  it('names what is missing, with the fix, in words rather than colour', async () => {
    const api = apiWith({
      ready: false,
      checks: [
        ok('harness', 'Agent runtime'),
        {
          id: 'git',
          label: 'Git',
          state: 'missing',
          detail: 'git could not be run.',
          fix: 'Install Git',
        },
        {
          id: 'projects',
          label: 'Projects',
          state: 'todo',
          detail: 'No projects yet.',
          fix: 'Add a project',
        },
      ],
    })
    const { wrapper } = await mountScreen(SetupChecklist, '/', api)
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Odin needs a few things')
    expect(text).toContain('Needed')
    expect(text).toContain('Install Git')
    expect(text).toContain('Next step')
    expect(text).not.toContain('Agent runtime')
  })
})
