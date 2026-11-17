import { beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import SessionFiles from './SessionFiles.vue'
import { useDrafts } from '@/app/drafts'
import { IuCsvViewer } from '@/components/CsvViewer'
import { IuDialog } from '@/components/Modal'
const editorStub = { props: ['modelValue', 'mode', 'label'], template: '<div />' }
beforeAll(() => {
  // jsdom has no <dialog> modal API; IuDialog calls these when it opens
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open')
  }
})

describe('SessionFiles', () => {
  it('adds selected CSV rows and original references to the existing composer draft', async () => {
    const api = createMockApi()
    const session = await api.getSession(FIXTURE_SESSION_IDS.idle)
    const id = session.id
    api.readSessionFile = async () => ({
      path: 'data.tsv',
      content: 'id\tname\n001\tAlice',
      version: 'v1',
      size: 17,
    })
    const wrapper = mount(SessionFiles, {
      props: { session },
      global: { provide: { [API_KEY as symbol]: api }, stubs: { IuMarkdownEditor: editorStub } },
    })
    await (wrapper.vm as unknown as { open(path: string): Promise<void> }).open('data.tsv')
    await flushPromises()
    useDrafts().set(id, { text: 'Existing message', attachments: [] })
    wrapper.findComponent(IuCsvViewer).vm.$emit('selection', {
      delimiter: '\t',
      rows: [{ record: 2, line: 2, values: ['001', 'Alice'] }],
    })
    expect(useDrafts().get(id).text).toContain('Existing message\n\nSelected rows from data.tsv:')
    expect(useDrafts().get(id).text).toContain('"001"')
    expect(useDrafts().get(id).text).toContain('"record": 2')
    wrapper.unmount()
  })
  it('preserves a draft when saving conflicts with an agent edit', async () => {
    const api = createMockApi()
    const session = await api.getSession(FIXTURE_SESSION_IDS.idle)
    const id = session.id
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: SessionFiles }],
    })
    await router.push('/')
    const wrapper = mount(SessionFiles, {
      props: { session },
      global: {
        plugins: [router],
        provide: { [API_KEY as symbol]: api },
        stubs: { IuMarkdownEditor: editorStub },
      },
    })
    await flushPromises()
    const readme = wrapper.findAll('button').find(b => b.text() === 'README.md')!
    await readme.trigger('click')
    await flushPromises()
    const original = await api.readSessionFile(id, 'README.md')
    wrapper.findComponent(editorStub).vm.$emit('update:modelValue', '# My draft')
    await flushPromises()
    // Collapse and expand the sidebar to verify the draft is preserved
    await wrapper
      .findAll('button')
      .find(b => b.attributes('aria-label') === 'Collapse file browser')!
      .trigger('click')
    expect(wrapper.find('.session-files__sidebar').classes()).toContain(
      'session-files__sidebar--collapsed',
    )
    expect(wrapper.findComponent(editorStub).props('modelValue')).toBe('# My draft')
    await wrapper
      .findAll('button')
      .find(b => b.attributes('aria-label') === 'Expand file browser')!
      .trigger('click')
    expect(wrapper.find('.session-files__sidebar').classes()).not.toContain(
      'session-files__sidebar--collapsed',
    )
    await api.saveSessionFile(id, 'README.md', '# Agent edit', original.version)
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Save')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Your draft is preserved')
    expect(wrapper.findComponent(editorStub).props('modelValue')).toBe('# My draft')
    expect((await api.readSessionFile(id, 'README.md')).content).toBe('# Agent edit')
    wrapper.unmount()
  })
  async function mountFiles() {
    const api = createMockApi()
    const session = await api.getSession(FIXTURE_SESSION_IDS.idle)
    const wrapper = mount(SessionFiles, {
      props: { session },
      global: {
        provide: { [API_KEY as symbol]: api },
        stubs: { IuMarkdownEditor: editorStub, IuCodeEditor: editorStub, CodeEditor: editorStub },
      },
    })
    await flushPromises()
    const button = (text: string) => wrapper.findAll('button').find(b => b.text() === text)!
    const menuItem = (text: string) =>
      wrapper.findAll('[role="menuitem"]').find(b => b.text().startsWith(text))!
    /** New → Notebook: the one file type the existing create flow can write. */
    const newNotebook = async () => {
      await button('New').trigger('click')
      await menuItem('Notebook').trigger('click')
      await flushPromises()
    }
    return { api, session, wrapper, button, menuItem, newNotebook }
  }
  it('opens a .ipynb from the browser as a notebook document in the same tab strip', async () => {
    const { api, session, wrapper, button } = await mountFiles()
    const open = vi.spyOn(api, 'openNotebook')
    await button('README.md').trigger('click')
    await flushPromises()
    await button('analysis.ipynb').trigger('click')
    await flushPromises()
    expect(open).toHaveBeenCalledWith(session.project, {
      path: 'analysis.ipynb',
      create: false,
      sessionId: session.id,
    })
    const tabs = wrapper.findAll('[role="tab"]')
    expect(tabs.map(t => t.attributes('aria-label'))).toEqual(['README.md', 'analysis.ipynb'])
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
    await vi.waitFor(() =>
      expect(wrapper.findComponent({ name: 'NotebookDocument' }).exists()).toBe(true),
    )
    expect(wrapper.findAll('button button')).toHaveLength(0)
    wrapper.unmount()
  })
  it('shows the notebook as saved, read-only, when it cannot be opened as one', async () => {
    const { api, wrapper, button } = await mountFiles()
    api.openNotebook = async () => {
      throw new Error('Kernel host is down')
    }
    await button('analysis.ipynb').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'NotebookDocument' }).exists()).toBe(false)
    expect(wrapper.text()).toContain('Kernel host is down')
    await vi.waitFor(() => expect(wrapper.text()).toContain('A first look at the results.'))
    expect(
      wrapper.findAll('[aria-label="Notebook as saved"] button').map(b => b.text()),
    ).not.toContain('Run')
    wrapper.unmount()
  })
  it('writes Untitled.ipynb in the folder on show, then Untitled-2, and opens it', async () => {
    const { api, session, wrapper, button, newNotebook } = await mountFiles()
    const open = vi.spyOn(api, 'openNotebook')
    await newNotebook()
    await flushPromises()
    expect(open).toHaveBeenCalledWith(session.project, {
      path: 'Untitled.ipynb',
      create: true,
      sessionId: session.id,
    })
    expect(button('Untitled.ipynb')).toBeDefined()
    await newNotebook()
    expect(open).toHaveBeenCalledWith(session.project, {
      path: 'Untitled-2.ipynb',
      create: true,
      sessionId: session.id,
    })
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(2)
    await button('data').trigger('click')
    await flushPromises()
    await newNotebook()
    expect(open).toHaveBeenCalledWith(session.project, {
      path: 'data/Untitled.ipynb',
      create: true,
      sessionId: session.id,
    })
    wrapper.unmount()
  })
  it('gives the sidebar toggle its own icons, and keeps full screen with a file open', async () => {
    const { wrapper, button } = await mountFiles()
    await button('README.md').trigger('click')
    await flushPromises()
    const toggle = () => wrapper.find('.session-files__sidebar-toggle')
    const before = toggle().html()
    await toggle().trigger('click')
    expect(toggle().html()).not.toBe(before)
    expect(toggle().attributes('aria-expanded')).toBe('false')
    await wrapper.find('[aria-label="Full screen"]').trigger('click')
    expect(wrapper.find('[aria-label="Exit full screen"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('renders no preview area until a file is open, and the browser fills the panel', async () => {
    const { wrapper, button } = await mountFiles()
    expect(wrapper.text()).not.toContain('No files open')
    expect(wrapper.find('.session-files__main').exists()).toBe(false)
    expect(wrapper.find('.session-files--browse-only').exists()).toBe(true)
    await button('README.md').trigger('click')
    await flushPromises()
    expect(wrapper.find('.session-files__main').exists()).toBe(true)
    expect(wrapper.find('.session-files--browse-only').exists()).toBe(false)
    wrapper.unmount()
  })
  it('offers every file type in the New menu', async () => {
    const { wrapper, button } = await mountFiles()
    await button('New').trigger('click')
    const items = wrapper.findAll('[role="menuitem"]')
    expect(items.map(b => b.text())).toEqual([
      'Notebook (.ipynb)',
      'Markdown (.md)',
      'Text (.txt)',
      'JSON (.json)',
      'HTML (.html)',
      'Other…',
    ])
    expect(items.some(b => b.attributes('disabled') !== undefined)).toBe(false)
    wrapper.unmount()
  })
  it('creates Markdown and JSON files as untitled names in the folder on show, and opens them', async () => {
    const { api, session, wrapper, button, menuItem } = await mountFiles()
    const create = vi.spyOn(api, 'createSessionFile')
    await button('New').trigger('click')
    await menuItem('Markdown').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(session.id, 'untitled.md', '')
    expect(wrapper.findAll('[role="tab"]').map(t => t.attributes('aria-label'))).toContain(
      'untitled.md',
    )
    await button('New').trigger('click')
    await menuItem('Markdown').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(session.id, 'untitled-2.md', '')
    await button('New').trigger('click')
    await menuItem('JSON').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(session.id, 'untitled.json', '{}')
    expect((await api.readSessionFile(session.id, 'untitled.json')).content).toBe('{}')
    wrapper.unmount()
  })
  it('creates the new file in the folder being browsed', async () => {
    const { api, session, wrapper, button, menuItem } = await mountFiles()
    await button('data').trigger('click')
    await flushPromises()
    const create = vi.spyOn(api, 'createSessionFile')
    await button('New').trigger('click')
    await menuItem('Text').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(session.id, 'data/untitled.txt', '')
    expect(wrapper.findAll('button').some(b => b.text() === 'untitled.txt')).toBe(true)
    wrapper.unmount()
  })
  it('Other… takes a relative name, shows validation and server errors inline, then creates', async () => {
    const { api, session, wrapper, button, menuItem } = await mountFiles()
    const create = vi.spyOn(api, 'createSessionFile')
    await button('New').trigger('click')
    await menuItem('Other').trigger('click')
    await flushPromises()
    const input = wrapper.find('.session-files__dialog input')
    expect((input.element as HTMLInputElement).value).toBe('untitled.txt')
    await input.setValue('../escape.txt')
    await button('Create').trigger('click')
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Paths cannot contain “..”.')
    await input.setValue('README.md')
    await button('Create').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(session.id, 'README.md', '')
    expect(wrapper.find('.session-files__dialog').exists()).toBe(true)
    expect(wrapper.text()).toContain('A file or folder already exists at this path')
    await input.setValue('missing/notes.txt')
    await button('Create').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('The folder for this file does not exist')
    await input.setValue('todo.txt')
    await button('Create').trigger('click')
    await flushPromises()
    expect(create).toHaveBeenLastCalledWith(session.id, 'todo.txt', '')
    expect(wrapper.findComponent(IuDialog).props('open')).toBe(false)
    expect(wrapper.findAll('[role="tab"]').map(t => t.attributes('aria-label'))).toContain(
      'todo.txt',
    )
    wrapper.unmount()
  })
  it('Other… refuses notebook names and points to the Notebook entry', async () => {
    const { api, wrapper, button, menuItem } = await mountFiles()
    const create = vi.spyOn(api, 'createSessionFile')
    await button('New').trigger('click')
    await menuItem('Other').trigger('click')
    await flushPromises()
    await wrapper.find('.session-files__dialog input').setValue('analysis.ipynb')
    await button('Create').trigger('click')
    await flushPromises()
    expect(create).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Create notebooks with Notebook (.ipynb).')
    wrapper.unmount()
  })
})
