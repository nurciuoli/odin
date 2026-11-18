import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import SessionEnvironment from './SessionEnvironment.vue'

async function setup() {
  const api = createMockApi()
  const session = await api.getSession(FIXTURE_SESSION_IDS.idle)
  const wrapper = mount(SessionEnvironment, {
    props: { session },
    global: { provide: { [API_KEY as symbol]: api } },
  })
  await flushPromises()
  const click = async (label: string) => {
    const button = wrapper.findAll('button').find(b => b.text() === label)
    expect(button, label).toBeDefined()
    await button!.trigger('click')
    await flushPromises()
  }
  return { api, session, wrapper, click }
}

describe('session environment tab', () => {
  it('shows the detected environment and offers to check again', async () => {
    const { api, session, wrapper, click } = await setup()
    expect(wrapper.text()).toContain('.venv/bin/python')
    expect(wrapper.text()).toContain('ready for notebooks')
    const detect = vi.spyOn(api, 'notebookEnvironment')
    await click('Check again')
    expect(detect).toHaveBeenCalledWith(session.project)
    wrapper.unmount()
  })
  it('sets up Python with one click, without asking where it runs', async () => {
    const { api, session, wrapper, click } = await setup()
    vi.spyOn(api, 'notebookEnvironment').mockResolvedValue({
      kind: 'missing',
      interpreter: null,
      managedHostPython: 'odin/python',
      needsSetup: true,
      location: { kind: 'native' },
    })
    await click('Check again')
    expect(wrapper.text()).toContain('No Python environment yet')
    const setupEnv = vi.spyOn(api, 'setupNotebookEnvironment')
    await click('Set up Python')
    expect(setupEnv).toHaveBeenCalledWith(session.project)
    expect(wrapper.text()).not.toContain('WSL')
    expect(wrapper.text()).not.toContain('Native')
    wrapper.unmount()
  })
  it('lists the project’s kernels and stops one', async () => {
    const { api, session, wrapper, click } = await setup()
    expect(wrapper.text()).toContain('No notebook kernels yet')
    await api.openNotebook(session.project, {
      path: 'A.ipynb',
      create: true,
      interpreter: '.venv/bin/python',
    })
    wrapper.unmount()
    const next = mount(SessionEnvironment, {
      props: { session },
      global: { provide: { [API_KEY as symbol]: api } },
    })
    await flushPromises()
    expect(next.text()).toContain('A.ipynb')
    const stop = vi.spyOn(api, 'stopNotebook')
    const button = next.find('[aria-label="Stop kernel for A.ipynb"]')
    expect(button.attributes('disabled')).toBeDefined()
    expect(stop).not.toHaveBeenCalled()
    expect(click).toBeDefined()
    next.unmount()
  })
})
