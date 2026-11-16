import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import NotebookPanel from './NotebookPanel.vue'
import NotebookOutput from './NotebookOutput.vue'

const editor = {
  name: 'NotebookTestEditor',
  props: ['modelValue', 'readonly', 'label'],
  template: '<div />',
}
async function setup() {
  const api = createMockApi()
  const session = await api.getSession(FIXTURE_SESSION_IDS.idle)
  const kernel = await api.createNotebook(session.project, {
    name: 'Analysis',
    cwd: '/shared/kernel',
  })
  await api.attachNotebook(session.id, kernel.id)
  const snapshot = await api.getNotebook(kernel.id)
  await api.saveNotebook(kernel.id, snapshot.revision, [
    {
      id: 'cell',
      kind: 'code',
      source: 'print(1)',
      outputs: [],
      executionCount: null,
      author: { kind: 'agent', sessionId: session.id },
    },
  ])
  const inspect = vi.spyOn(api, 'notebookVariables')
  const wrapper = mount(NotebookPanel, {
    props: { session },
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
  return { api, session, kernel, wrapper, click, inspect }
}
describe('notebook panel', () => {
  it('shows the actual shared directory and only executes after a user action', async () => {
    const { api, wrapper, click, inspect } = await setup()
    expect(wrapper.text()).toContain('/shared/kernel')
    expect(wrapper.text()).toContain('shared kernel runs in the directory shown above')
    expect(inspect).not.toHaveBeenCalled()
    const execute = vi.spyOn(api, 'executeNotebook')
    expect(execute).not.toHaveBeenCalled()
    await click('Run cell')
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0]![1]).not.toHaveProperty('sessionId')
    expect(wrapper.text()).toContain('Mock output')
    wrapper.unmount()
  })
  it('preserves the local draft across an agent update and offers explicit conflict resolution', async () => {
    const { api, wrapper, kernel, click } = await setup()
    expect(wrapper.findComponent({ name: 'NotebookTestEditor' }).exists(), wrapper.html()).toBe(
      true,
    )
    wrapper
      .findComponent({ name: 'NotebookTestEditor' })
      .vm.$emit('update:modelValue', 'my pending edit')
    await flushPromises()
    const snapshot = await api.getNotebook(kernel.id)
    snapshot.cells[0]!.source = 'agent update'
    await api.saveNotebook(kernel.id, snapshot.revision, snapshot.cells)
    await flushPromises()
    expect(wrapper.findComponent({ name: 'NotebookTestEditor' }).props('modelValue')).toBe(
      'my pending edit',
    )
    expect(wrapper.text()).toContain('Your draft is preserved')
    await click('Load latest and discard draft')
    expect(wrapper.findComponent({ name: 'NotebookTestEditor' }).props('modelValue')).toBe(
      'agent update',
    )
    wrapper.unmount()
  })
  it('locks editing and running during exclusive JupyterLab hand-off', async () => {
    const { wrapper, click } = await setup()
    await click('Prepare JupyterLab hand-off')
    expect(wrapper.findComponent({ name: 'NotebookTestEditor' }).props('readonly')).toBe(true)
    const run = wrapper.findAll('button').find(b => b.text() === 'Run cell')!
    expect(run.attributes('disabled')).toBeDefined()
    expect(wrapper.find('a[target="_blank"]').attributes('rel')).toBe('noopener')
    await click('Return control to Odin')
    expect(wrapper.findComponent({ name: 'NotebookTestEditor' }).props('readonly')).toBe(false)
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
