import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
async function setup(interpreter = '.venv/bin/python', detect?: () => typeof missing) {
  const api = createMockApi()
  if (detect) api.notebookEnvironment = async () => detect()
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
  const chipMenu = async (label: string) => {
    await wrapper.find('.nb-chip').trigger('click')
    await flushPromises()
    const item = wrapper.findAll('[role^="menuitem"]').find(b => b.text().includes(label))
    expect(item, label).toBeDefined()
    await item!.trigger('click')
    await flushPromises()
  }
  return { api, session, kernel, wrapper, click, menu, chipMenu }
}
const missing = {
  kind: 'missing' as const,
  interpreter: null,
  managedHostPython: 'odin/python',
  needsSetup: true,
}
const chip = (wrapper: ReturnType<typeof mount>) => wrapper.find('.nb-chip')
describe('notebook document', () => {
  it('is named as the file it is, and the kernel chip names the interpreter', async () => {
    const { wrapper } = await setup()
    expect(wrapper.find('.doc-header__name').text()).toBe('Analysis.ipynb')
    expect(chip(wrapper).text()).toContain('Python (.venv)')
    expect(chip(wrapper).attributes('aria-label')).toContain('stopped')
    expect(wrapper.find('.doc-header__status').text()).not.toContain('Kernel')
    wrapper.unmount()
  })
  it('detects the environment silently on open and takes it, with no banner', async () => {
    const { wrapper } = await setup('')
    expect(chip(wrapper).text()).toContain('Python (.venv)')
    expect(wrapper.text()).not.toContain('No Python environment')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    wrapper.unmount()
  })
  it('reads Select kernel and one quiet line when no Python is found', async () => {
    const { wrapper } = await setup('', () => missing)
    expect(chip(wrapper).text()).toContain('Select kernel')
    expect(chip(wrapper).classes()).toContain('nb-chip--none')
    expect(wrapper.findAll('.nb-cell__note')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('No Python environment')
    expect(wrapper.find('.iu-callout').exists()).toBe(false)
    wrapper.unmount()
  })
  it('says Select kernel again when a run is refused for want of Python', async () => {
    const { api, wrapper, click } = await setup()
    vi.spyOn(api, 'executeNotebook').mockRejectedValue(
      new ApiRequestError(409, 'no Python environment'),
    )
    expect(chip(wrapper).text()).not.toContain('Select kernel')
    await click('Run')
    expect(chip(wrapper).text()).toContain('Select kernel')
    expect(wrapper.find('.nb-cell__error').exists()).toBe(false)
    wrapper.unmount()
  })
  it('shows a failed run on its cell, inline', async () => {
    const { api, wrapper, click } = await setup()
    vi.spyOn(api, 'executeNotebook').mockRejectedValue(new Error('kernel died'))
    await click('Run')
    expect(wrapper.find('.nb-cell__error').text()).toBe('kernel died')
    expect(wrapper.find('.nb-doc__lines').exists()).toBe(false)
    expect(wrapper.find('.nb-cell').attributes('data-status')).toBe('failed')
    wrapper.unmount()
  })
  it('has no cwd-mismatch notice', async () => {
    const { wrapper } = await setup()
    expect(wrapper.text()).not.toContain('This shared kernel')
    wrapper.unmount()
  })
  it('sends Set up Python environment and Kernel details to the Environment tab', async () => {
    const { wrapper, chipMenu } = await setup()
    await chipMenu('Set up Python environment')
    await chipMenu('Kernel details')
    expect(wrapper.emitted('open-environment')).toHaveLength(2)
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
  it('keeps the kernel chores in the chip menu: variables on request only', async () => {
    const { api, wrapper, chipMenu } = await setup()
    const inspect = vi.spyOn(api, 'notebookVariables')
    expect(inspect).not.toHaveBeenCalled()
    await chipMenu('Variables')
    expect(inspect).toHaveBeenCalledOnce()
    wrapper.unmount()
  })
  describe('by the pane width', () => {
    const observers: { cb: ResizeObserverCallback }[] = []
    const widthOf = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    class FakeObserver {
      constructor(cb: ResizeObserverCallback) {
        observers.push({ cb })
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    }
    beforeEach(() => {
      observers.length = 0
      widthOf.mockReturnValue(80)
      vi.stubGlobal('ResizeObserver', FakeObserver)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })
    const resizeTo = async (wrapper: ReturnType<typeof mount>, pane: number, toolbar: number) => {
      const entry = (target: Element, width: number) =>
        ({ target, contentRect: { width } }) as unknown as ResizeObserverEntry
      for (const o of observers)
        o.cb(
          [entry(wrapper.element, pane), entry(wrapper.find('.nb-doc__toolbar').element, toolbar)],
          {} as ResizeObserver,
        )
      await flushPromises()
    }
    it('folds the buttons that do not fit into a menu, leaving the chip', async () => {
      const { wrapper } = await setup()
      const buttons = () => wrapper.findAll('.nb-doc__toolbar > button').length
      await resizeTo(wrapper, 700, 1000)
      expect(wrapper.find('[aria-label="More notebook actions"]').exists()).toBe(false)
      expect(buttons()).toBe(5)
      await resizeTo(wrapper, 700, 300)
      expect(wrapper.find('[aria-label="More notebook actions"]').exists()).toBe(true)
      expect(buttons()).toBeLessThan(5)
      expect(wrapper.find('.nb-chip').exists()).toBe(true)
      wrapper.unmount()
    })
    it('shows the outline only when the pane is wide', async () => {
      const { wrapper } = await setup()
      await resizeTo(wrapper, 1099, 1000)
      expect(wrapper.find('[aria-label="Notebook outline"]').exists()).toBe(false)
      await resizeTo(wrapper, 1100, 1000)
      const outline = wrapper.find('[aria-label="Notebook outline"]')
      expect(outline.exists()).toBe(true)
      expect(outline.text()).toContain('print(1)')
      wrapper.unmount()
    })
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
