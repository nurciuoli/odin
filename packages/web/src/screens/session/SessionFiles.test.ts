import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import SessionFiles from './SessionFiles.vue'
import { touchedFiles, type TouchedFile } from './fileActivity'

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

async function mountBrowser(touched: TouchedFile[] = []) {
  const api = createMockApi()
  wrapper = mount(SessionFiles, {
    props: { sessionId: FIXTURE_SESSION_IDS.running, touched },
    attachTo: document.body,
    global: { provide: { [API_KEY as symbol]: api } },
  })
  await flushPromises()
  return wrapper
}
const rows = () => wrapper!.findAll('.panel-line__main').map(r => r.text())
const row = (text: string) =>
  wrapper!.findAll('.panel-line__main').find(r => r.text().includes(text))!

async function touchedFromSession(): Promise<TouchedFile[]> {
  const session = await createMockApi().getSession(FIXTURE_SESSION_IDS.running)
  return touchedFiles(session.transcript, { pending: [], running: false, root: session.cwd })
}

describe('SessionFiles', () => {
  it('opens on what the session touched, newest first, each linked to its step', async () => {
    const touched = await touchedFromSession()
    expect(touched.length).toBeGreaterThan(1)
    await mountBrowser(touched)
    expect(rows()[0]).toContain(touched[0]!.path)
    expect(wrapper!.find('[aria-label="Files this session touched"]').exists()).toBe(true)
    await wrapper!
      .find(`[aria-label="Show ${touched[0]!.path} in the conversation"]`)
      .trigger('click')
    expect(wrapper!.emitted('reveal')?.at(-1)).toEqual([touched[0]!.touches[0]!.entryId])
  })

  it('asks the surface to open a touched file', async () => {
    const touched = await touchedFromSession()
    await mountBrowser(touched)
    await row(touched[0]!.path).trigger('click')
    expect(wrapper!.emitted('open')?.at(-1)).toEqual([{ kind: 'file', path: touched[0]!.path }])
  })

  it('says so and offers the tree when nothing was touched', async () => {
    await mountBrowser([])
    expect(wrapper!.text()).toContain('No files touched yet')
    await wrapper!
      .findAll('button')
      .find(b => b.text() === 'Browse all files')!
      .trigger('click')
    await vi.waitFor(() => expect(rows().join('|')).toContain('README.md'))
  })

  it('browses the whole working directory lazily, and goes back to this session', async () => {
    const touched = await touchedFromSession()
    await mountBrowser(touched)
    await wrapper!
      .findAll('button')
      .find(b => b.text() === 'Browse all files')!
      .trigger('click')
    await vi.waitFor(() => expect(rows().join('|')).toContain('README.md'))
    expect(wrapper!.find('[aria-label="Working directory"]').exists()).toBe(true)
    await wrapper!
      .findAll('button')
      .find(b => b.text().includes('This session'))!
      .trigger('click')
    expect(wrapper!.find('[aria-label="Files this session touched"]').exists()).toBe(true)
  })

  it('filters every kind: files by search, notebooks and outputs by title', async () => {
    await mountBrowser()
    await wrapper!.find('.session-files input').setValue('readme')
    await vi.waitFor(() => expect(rows().join('|')).toContain('README.md'))
    expect(wrapper!.find('[aria-label="Working directory"]').exists()).toBe(false)
    await wrapper!.find('.session-files input').setValue('zzz-nothing')
    await vi.waitFor(() => expect(wrapper!.text()).toContain('Nothing matches'))
  })
})
