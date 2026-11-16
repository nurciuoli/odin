import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import SessionFiles from './SessionFiles.vue'
import { useDrafts } from '@/app/drafts'
import { IuCsvViewer } from '@/components/CsvViewer'
const editorStub = { props: ['modelValue', 'mode', 'label'], template: '<div />' }

describe('SessionFiles', () => {
  it('adds selected CSV rows and original references to the existing composer draft', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.idle
    api.readSessionFile = async () => ({
      path: 'data.tsv',
      content: 'id\tname\n001\tAlice',
      version: 'v1',
      size: 17,
    })
    const wrapper = mount(SessionFiles, {
      props: { sessionId: id },
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
    const id = FIXTURE_SESSION_IDS.idle
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/', component: SessionFiles }],
    })
    await router.push('/')
    const wrapper = mount(SessionFiles, {
      props: { sessionId: id },
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
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Full preview')!
      .trigger('click')
    expect(wrapper.find('.session-files__listing').attributes('style')).toContain('display: none')
    expect(wrapper.findComponent(editorStub).props('modelValue')).toBe('# My draft')
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Show browser')!
      .trigger('click')
    expect(wrapper.find('.session-files__listing').attributes('style') ?? '').not.toContain(
      'display: none',
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
})
