import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import SessionWorkbench from './SessionWorkbench.vue'

const editorStub = { props: ['modelValue', 'mode', 'label'], template: '<div />' }
let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})
async function mountSurface(
  tab: 'docs' | 'side' | 'activity' = 'docs',
  id = FIXTURE_SESSION_IDS.running,
) {
  const api = createMockApi()
  const session = await api.getSession(id)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: {} }],
  })
  await router.push('/')
  wrapper = mount(SessionWorkbench, {
    props: {
      session,
      width: 700,
      tab,
      artifacts: api.db.artifacts.filter(a => a.sessionId === id),
      'onUpdate:tab': (t: string) => wrapper!.setProps({ tab: t }),
    },
    attachTo: document.body,
    global: {
      plugins: [router],
      provide: { [API_KEY as symbol]: api },
      stubs: { IuMarkdownEditor: editorStub },
    },
  })
  await flushPromises()
  return wrapper
}
const rows = () => wrapper!.findAll('.panel-line__main').map(r => r.text())
const row = (text: string) =>
  wrapper!.findAll('.panel-line__main').find(r => r.text().includes(text))
async function press(text: string) {
  await row(text)!.trigger('click')
  await vi.dynamicImportSettled()
  await flushPromises()
}
const browserShown = () => wrapper!.find('.session-workbench__page').isVisible()
const shownTitle = () =>
  wrapper!
    .findAll('.doc-header__name')
    .find(h => h.isVisible())
    ?.text()
async function browseAll() {
  await wrapper!
    .findAll('button')
    .find(b => b.text() === 'Browse all files')!
    .trigger('click')
  await vi.waitFor(() => expect(rows().join('|')).toContain('README.md'))
}

describe('SessionWorkbench', () => {
  it('opens on the browser: what the session touched, then outputs and notebooks', async () => {
    await mountSurface()
    expect(wrapper!.find('.session-workbench__tabs').exists()).toBe(false)
    expect(browserShown()).toBe(true)
    expect(
      wrapper!.find('.session-files__rows[aria-label="Files this session touched"]').exists(),
    ).toBe(true)
    await vi.waitFor(() => expect(rows().join('|')).toContain('Revenue analysis.ipynb'))
    expect(wrapper!.find('[aria-label="Outputs"]').exists()).toBe(false)
    expect(rows().join('|')).toContain('New notebook')
  })

  it('opens a file from the browser in place, and back returns to the browser', async () => {
    await mountSurface()
    await browseAll()
    expect(wrapper!.find('.session-files__steps').exists()).toBe(false)
    await press('README.md')
    expect(browserShown()).toBe(false)
    expect(shownTitle()).toBe('README.md')
    expect(wrapper!.find('.session-workbench__tabs').exists()).toBe(false)

    await wrapper!.find('[aria-label="Back to files"]').trigger('click')
    expect(browserShown()).toBe(true)
    // the open file is still open: the browser lists it
    expect(wrapper!.find('[aria-label="Open documents"]').text()).toContain('README.md')
  })

  it('keeps drafts mounted while moving between open files and notebooks with tabs', async () => {
    await mountSurface()
    await browseAll()
    await press('README.md')
    wrapper!.findComponent(editorStub).vm.$emit('update:modelValue', '# Draft')
    await wrapper!.find('[aria-label="Back to files"]').trigger('click')
    await flushPromises()
    await press('Revenue analysis.ipynb')
    await vi.waitFor(() => expect(wrapper!.text()).toContain('Revenue by quarter'))
    const tabs = wrapper!.findAll('[role="tab"]')
    expect(tabs.map(t => t.text())).toEqual(['README.md •', 'Revenue analysis.ipynb'])
    await tabs[0]!.trigger('click')
    expect(wrapper!.findComponent(editorStub).props('modelValue')).toBe('# Draft')
  })

  it('lists the session outputs in the browser', async () => {
    await mountSurface(undefined, FIXTURE_SESSION_IDS.idle)
    expect(wrapper!.find('[aria-label="Outputs"]').text()).toContain('Pick a History layout')
  })
  it('opens a notebook file that has a kernel as that notebook, and one without as its cells', async () => {
    await mountSurface()
    const surface = wrapper!.vm as unknown as { openFile(path: string): void }
    surface.openFile('Revenue analysis.ipynb')
    await vi.waitFor(() => expect(wrapper!.find('.nb-doc').exists()).toBe(true))
    surface.openFile('experiments/baseline.ipynb')
    await flushPromises()
    expect(wrapper!.find('.file-doc').exists()).toBe(true)
    expect(wrapper!.text()).toContain('Start a kernel')
  })

  it('opens the notebook a thread step points at, on that cell', async () => {
    await mountSurface()
    const surface = wrapper!.vm as unknown as {
      openCell(cell: { kernelId: string; cellId: string }): void
    }
    surface.openCell({ kernelId: 'notebook-seed', cellId: 'c2' })
    await vi.waitFor(() => expect(wrapper!.find('[data-cell="c2"]').exists()).toBe(true))
    expect(browserShown()).toBe(false)
    expect(shownTitle()).toBe('Revenue analysis.ipynb')
  })

  it('filters across files, notebooks and outputs', async () => {
    await mountSurface()
    await wrapper!.find('.session-files input').setValue('revenue')
    await vi.waitFor(() =>
      expect(rows().some(r => r.includes('Revenue analysis.ipynb'))).toBe(true),
    )
    await wrapper!.find('.session-files input').setValue('zzz-nothing')
    await vi.waitFor(() => expect(wrapper!.text()).toContain('Nothing matches'))
  })

  it('puts the panel away from the header menu', async () => {
    await mountSurface()
    await browseAll()
    await press('README.md')
    await wrapper!.find('[aria-label^="More actions"]').trigger('click')
    await flushPromises()
    await wrapper!
      .findAll('[role^="menuitem"]')
      .find(b => b.text().includes('Hide panel'))!
      .trigger('click')
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })
})
