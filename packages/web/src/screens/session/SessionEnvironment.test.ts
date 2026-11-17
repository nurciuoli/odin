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
  it('shows the detected environment and offers to detect again and set up', async () => {
    const { api, session, wrapper, click } = await setup()
    expect(wrapper.text()).toContain('.venv/bin/python')
    const detect = vi.spyOn(api, 'notebookEnvironment')
    const setupEnv = vi.spyOn(api, 'setupNotebookEnvironment')
    await click('Detect again')
    expect(detect).toHaveBeenCalledWith(session.project, { kind: 'native' })
    await click('Set up Python environment')
    expect(setupEnv).toHaveBeenCalledWith(session.project, { kind: 'native' })
    wrapper.unmount()
  })
  it('offers WSL only on Windows', async () => {
    const { wrapper } = await setup()
    expect(wrapper.text()).not.toContain('WSL')
    wrapper.unmount()
    window.odinDesktop = { platform: 'win32' }
    const win = await setup()
    expect(win.wrapper.text()).toContain('WSL')
    win.wrapper.unmount()
    delete window.odinDesktop
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
