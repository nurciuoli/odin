import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import type { Artifact } from '@odin/shared/api'
import { API_KEY } from '@/api'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createMockApi } from '@/api/mock'
import ArtifactPanel from './ArtifactPanel.vue'
import { artifactOrder, newestArtifact, tabLabel, versionNumbers } from './artifacts'

let wrapper: VueWrapper<InstanceType<typeof ArtifactPanel>> | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

const api = createMockApi()
const of = (session: string) => api.db.artifacts.filter(a => a.sessionId === session)

async function mountPanel(artifacts: Artifact[], props: Record<string, unknown> = {}) {
  wrapper = mount(ArtifactPanel, {
    props: { artifacts, presentation: 'overlay', open: true, ...props },
    attachTo: document.body,
    global: { provide: { [API_KEY as symbol]: api } },
  })
  await flushPromises()
  return wrapper
}

const visibleFrame = () =>
  wrapper!.findAll('.artifact-panel__view').find(v => v.attributes('style') === undefined)!

async function gear(label: string) {
  await wrapper!.find('[aria-label="Artifact settings"]').trigger('click')
  await flushPromises()
  const item = wrapper!.findAll('[role^="menuitem"]').find(b => b.text().includes(label))!
  await item.trigger('click')
  await flushPromises()
}

describe('ArtifactPanel', () => {
  it('shows a single artifact under its title, in the sandboxed frame', async () => {
    await mountPanel(of(FIXTURE_SESSION_IDS.idle))
    expect(wrapper!.find('h2').text()).toBe('Pick a History layout')
    expect(wrapper!.find('[role="tablist"]').exists()).toBe(false)
    const iframe = wrapper!.find('iframe')
    expect(iframe.attributes('sandbox')).toBe('allow-scripts allow-forms')
    expect(iframe.attributes('src')).toBe(api.artifactUrl(1, 1))
    // nothing but its own URL: no inline document
    expect(Object.keys(iframe.attributes()).sort()).toEqual(['class', 'sandbox', 'src', 'title'])
  })

  it('puts several artifacts in tabs and opens on the newest', async () => {
    await mountPanel(of(FIXTURE_SESSION_IDS.ended))
    const tabs = wrapper!.findAll('[role="tab"]')
    expect(tabs.map(t => t.text())).toEqual(['Removal checklist', 'Module dependency map'])
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
    expect(visibleFrame().find('iframe').attributes('src')).toBe(api.artifactUrl(3, 1))
    // the shown tab labels its panel
    expect(visibleFrame().attributes('role')).toBe('tabpanel')
    expect(visibleFrame().attributes('aria-labelledby')).toBe(tabs[1]!.attributes('id'))

    await tabs[0]!.trigger('click')
    expect(visibleFrame().find('iframe').attributes('src')).toBe(api.artifactUrl(2, 2))
    // the tab seen before stays mounted, hidden, so its page keeps its state
    expect(wrapper!.findAll('iframe')).toHaveLength(2)
  })

  it('steps through versions from the gear', async () => {
    await mountPanel(of(FIXTURE_SESSION_IDS.ended))
    await wrapper!.findAll('[role="tab"]')[0]!.trigger('click')
    await flushPromises()
    expect(wrapper!.find('.artifact-panel__version').text()).toBe('v2 of 2')
    await gear('Previous version')
    expect(wrapper!.find('.artifact-panel__version').text()).toBe('v1 of 2')
    expect(visibleFrame().find('iframe').attributes('src')).toBe(api.artifactUrl(2, 1))
    await gear('Show latest')
    expect(wrapper!.find('.artifact-panel__version').text()).toBe('v2 of 2')
  })

  it('widens from the gear', async () => {
    await mountPanel(of(FIXTURE_SESSION_IDS.idle))
    const aside = () => wrapper!.find('aside').attributes('style')
    expect(aside()).toContain('520px')
    await gear('Wide panel')
    expect(aside()).toContain('720px')
  })

  it('selects a newly arrived artifact without moving focus', async () => {
    const list = of(FIXTURE_SESSION_IDS.idle)
    await mountPanel(list)
    const focused = document.activeElement
    const fresh: Artifact = {
      ...list[0]!,
      id: 99,
      title: 'Fresh one',
      createdAt: new Date().toISOString(),
    }
    await wrapper!.setProps({ artifacts: [...list, fresh] })
    await flushPromises()
    const tabs = wrapper!.findAll('[role="tab"]')
    expect(tabs.map(t => t.text())).toEqual(['Pick a History layout', 'Fresh one'])
    expect(tabs[1]!.attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(focused)
  })

  it('shows the artifact and version a card asks for', async () => {
    await mountPanel(of(FIXTURE_SESSION_IDS.ended))
    wrapper!.vm.show(2, 1)
    await flushPromises()
    expect(wrapper!.findAll('[role="tab"]')[0]!.attributes('aria-selected')).toBe('true')
    expect(visibleFrame().find('iframe').attributes('src')).toBe(api.artifactUrl(2, 1))
    expect(wrapper!.emitted('shown')?.at(-1)).toEqual([2, 1])
  })

  it('is a closable drawer as an overlay, and Escape closes it', async () => {
    await mountPanel(of(FIXTURE_SESSION_IDS.idle), { presentation: 'overlay', open: true })
    expect(wrapper!.find('aside').attributes('role')).toBe('dialog')
    expect(wrapper!.find('[aria-label="Close panel"]').exists()).toBe(true)
    await wrapper!.find('aside').trigger('keydown', { key: 'Escape' })
    expect(wrapper!.emitted('update:open')?.at(-1)).toEqual([false])
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })

  it('is a document inline: the shared header, no drawer chrome, version steps in its menu', async () => {
    await mountPanel(of(FIXTURE_SESSION_IDS.idle), { presentation: 'inline' })
    expect(wrapper!.find('[aria-label="Close panel"]').exists()).toBe(false)
    expect(wrapper!.find('.doc-header').exists()).toBe(true)
    expect(wrapper!.find('aside').exists()).toBe(false)
    expect(wrapper!.find('.doc-header__name').text()).toBe(
      of(FIXTURE_SESSION_IDS.idle).at(-1)!.title,
    )
    await wrapper!.find('[aria-label^="Close "]').trigger('click')
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })
})

describe('artifact rules', () => {
  const a = (id: number, createdAt: string): Artifact => ({
    id,
    project: 'p',
    sessionId: 's',
    title: `A${id}`,
    latestVersion: 1,
    createdAt,
    updatedAt: createdAt,
  })
  it('orders by posting and picks the newest', () => {
    const list = [a(2, '2026-01-02'), a(1, '2026-01-01'), a(3, '2026-01-03')]
    expect(artifactOrder(list).map(x => x.id)).toEqual([1, 2, 3])
    expect(newestArtifact(list)?.id).toBe(3)
    expect(newestArtifact([])).toBeNull()
  })
  it('shortens long tab labels', () => {
    expect(tabLabel('Short')).toBe('Short')
    expect(tabLabel('A very long artifact title that keeps going', 12)).toBe('A very long…')
  })
  it('merges the version numbers it knows', () => {
    expect(versionNumbers([1, 2], 3, 1)).toEqual([1, 2, 3])
    expect(versionNumbers([], 2, 2)).toEqual([2])
  })
})
