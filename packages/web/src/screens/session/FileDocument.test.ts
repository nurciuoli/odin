import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import FileDocument from './FileDocument.vue'
import { useDrafts } from '@/app/drafts'
import { IuCsvViewer } from '@/components/CsvViewer'
import NotebookCell from './NotebookCell.vue'
const editorStub = { props: ['modelValue', 'mode', 'label'], template: '<div />' }
const id = FIXTURE_SESSION_IDS.idle

function mountFile(api: ReturnType<typeof createMockApi>, path: string) {
  return mount(FileDocument, {
    props: { sessionId: id, path },
    global: { provide: { [API_KEY as symbol]: api }, stubs: { IuMarkdownEditor: editorStub } },
  })
}

describe('FileDocument', () => {
  it('wears the shared header: folder, name and a Saved status', async () => {
    const wrapper = mountFile(createMockApi(), 'src/example.ts')
    await flushPromises()
    expect(wrapper.find('.doc-header__dir').text()).toBe('src/')
    expect(wrapper.find('.doc-header__name').text()).toBe('example.ts')
    expect(wrapper.find('.doc-header__status').text()).toBe('Saved')
    wrapper.unmount()
  })
  it('says so when the file cannot be opened, and retries', async () => {
    const wrapper = mountFile(createMockApi(), 'missing.md')
    await flushPromises()
    expect(wrapper.text()).toContain('File not found')
    wrapper.unmount()
  })
  it('adds selected CSV rows and original references to the existing composer draft', async () => {
    const api = createMockApi()
    api.readSessionFile = async () => ({
      path: 'data.tsv',
      content: 'id\tname\n001\tAlice',
      version: 'v1',
      size: 17,
    })
    const wrapper = mountFile(api, 'data.tsv')
    await flushPromises()
    useDrafts().set(id, { text: 'Existing message', attachments: [] })
    wrapper.findComponent(IuCsvViewer).vm.$emit('selection', {
      delimiter: '\t',
      rows: [{ record: 2, line: 2, values: ['001', 'Alice'] }],
    })
    expect(useDrafts().get(id).text).toContain('Existing message\n\nSelected rows from data.tsv:')
    expect(useDrafts().get(id).text).toContain('"001"')
    wrapper.unmount()
  })
  it('preserves a draft when saving conflicts with an agent edit', async () => {
    const api = createMockApi()
    const wrapper = mountFile(api, 'README.md')
    await flushPromises()
    const original = await api.readSessionFile(id, 'README.md')
    wrapper.findComponent(editorStub).vm.$emit('update:modelValue', '# My draft')
    await flushPromises()
    expect(wrapper.find('.doc-header__status').text()).toBe('Unsaved changes')
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
  it('reads a notebook file as its cells, read-only, with a way to start a kernel', async () => {
    const wrapper = mountFile(createMockApi(), 'experiments/baseline.ipynb')
    await flushPromises()
    expect(wrapper.findAllComponents(NotebookCell)).toHaveLength(2)
    expect(wrapper.text()).toContain('45')
    expect(wrapper.find('.doc-header__status').text()).toContain('Read-only')
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Start a kernel')!
      .trigger('click')
    expect(wrapper.emitted('startNotebook')![0]).toEqual(['baseline'])
    wrapper.unmount()
  })
})
