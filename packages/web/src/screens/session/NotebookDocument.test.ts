import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { API_KEY, ApiRequestError } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import NotebookDocument from './NotebookDocument.vue'
import NotebookOutput from './NotebookOutput.vue'

const editor = {
  name: 'NotebookTestEditor',
  props: ['modelValue', 'readonly', 'label'],
  template: '<div />',
}
async function setup(interpreter = '.venv/bin/python') {
  const api = createMockApi()
  const session = await api.getSession(FIXTURE_SESSION_IDS.idle)
  const kernel = await api.openNotebook(session.project, {
    path: 'Analysis.ipynb',
    create: true,
    ...(interpreter ? { interpreter } : {}),
  })
  const snapshot = await api.getNotebook(kernel.id)
  await api.saveNotebook(kernel.id, snapshot.revision, [
    {
      id: 'cell',
      kind: 'code',
      source: 'print(1)',
      outputs: [],
      executionCount: null,
    },
  ])
  const wrapper = mount(NotebookDocument, {
    props: { session, kernelId: kernel.id },
    global: {
      provide: { [API_KEY as symbol]: api },
      stubs: { IuCodeEditor: editor, CodeEditor: editor },
    },
  })
  await flushPromises()
  const click = async (label: string) => {
    const button = wrapper.findAll('button').find(b => b.text() === label)
    expect(button, label).toBeDefined()
    await button!.trigger('click')
    await flushPromises()
  }
  const menu = async (label: string) => {
    await wrapper.find('[aria-label^="More actions"]').trigger('click')
    await flushPromises()
    const item = wrapper.findAll('[role^="menuitem"]').find(b => b.text().includes(label))
    expect(item, label).toBeDefined()
    await item!.trigger('click')
    await flushPromises()
  }
  return { api, session, kernel, wrapper, click, menu }
}
describe('notebook document', () => {
  it('is named as the file it is, and says what state the kernel is in', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('.doc-header__name').text()).toBe('Analysis.ipynb')
    expect(wrapper.find('.doc-header__status').text()).toContain('Kernel stopped')
    expect(wrapper.text()).not.toContain('No Python environment')
    wrapper.unmount()
  })
  it('asks for a Python environment in place, and opens the notebook again with it', async () => {
    const { api, session, wrapper, click } = await setup('')
    expect(wrapper.text()).toContain('No Python environment')
    expect(wrapper.find('.doc-header__status').text()).toContain('No Python environment')
    const open = vi.spyOn(api, 'openNotebook')
    await click('Detect environment')
    expect(open).toHaveBeenCalledWith(session.project, {
      path: 'Analysis.ipynb',
      interpreter: '.venv/bin/python',
      location: { kind: 'native' },
    })
    expect(wrapper.text()).not.toContain('Set up Python environment')
    wrapper.unmount()
  })
  it('offers the same prompt when a run is refused for want of Python', async () => {
    const { api, wrapper, click } = await setup()
    vi.spyOn(api, 'executeNotebook').mockRejectedValue(
      new ApiRequestError(409, 'no Python environment'),
    )
    expect(wrapper.text()).not.toContain('Set up Python environment')
    await click('Run')
    expect(wrapper.text()).toContain('Set up Python environment')
    wrapper.unmount()
  })
  it('has no JupyterLab hand-off', async () => {
    const { wrapper } = await setup()
    await wrapper.find('[aria-label^="More actions"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('JupyterLab')
    wrapper.unmount()
  })
  it('only executes after a user action, and shows the output under the cell', async () => {
    const { api, wrapper, click } = await setup()
    const execute = vi.spyOn(api, 'executeNotebook')
    const inspect = vi.spyOn(api, 'notebookVariables')
    expect(execute).not.toHaveBeenCalled()
    await click('Run')
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]![1]).not.toHaveProperty('sessionId')
    expect(inspect).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Mock output')
    wrapper.unmount()
  })
  it('preserves the local draft across an agent update and offers explicit conflict resolution', async () => {
    const { api, wrapper, kernel, click } = await setup()
    const source = () => wrapper.findComponent({ name: 'NotebookTestEditor' })
    source().vm.$emit('update:modelValue', 'my pending edit')
    await flushPromises()
    expect(wrapper.find('.doc-header__status').text()).toContain('Unsaved')
    const snapshot = await api.getNotebook(kernel.id)
    snapshot.cells[0]!.source = 'agent update'
    await api.saveNotebook(kernel.id, snapshot.revision, snapshot.cells)
    await flushPromises()
    expect(source().props('modelValue')).toBe('my pending edit')
    expect(wrapper.text()).toContain('Your draft is preserved')
    await click('Load latest and discard draft')
    expect(source().props('modelValue')).toBe('agent update')
    wrapper.unmount()
  })
  it('keeps the kernel chores in the menu: variables on request only', async () => {
    const { api, wrapper, menu } = await setup()
    const inspect = vi.spyOn(api, 'notebookVariables')
    await menu('Inspect variables')
    expect(inspect).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
  it('renders untrusted rich output only inside the sandboxed artifact frame', () => {
    const api = createMockApi()
    const wrapper = mount(NotebookOutput, {
      props: {
        kernelId: 'k',
        cellId: 'c',
        index: 0,
        output: { type: 'display', data: { 'text/html': '<script>danger()</script>' } },
      },
      global: { provide: { [API_KEY as symbol]: api } },
    })
    expect(wrapper.find('iframe').attributes('sandbox')).toBe('allow-scripts allow-forms')
    expect(wrapper.find('iframe').attributes('src')).toBe('/a/notebooks/k/c/0')
    expect(wrapper.html()).not.toContain('danger()')
    wrapper.unmount()
  })
})
