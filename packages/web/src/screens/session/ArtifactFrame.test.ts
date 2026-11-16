import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { API_KEY } from '@/api'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createMockApi } from '@/api/mock'
import ArtifactFrame from './ArtifactFrame.vue'

let wrapper: VueWrapper | undefined
afterEach(() => wrapper?.unmount())

async function mountFrame() {
  const api = createMockApi()
  // the fixture artifact has one version; give it a second to show
  api.db.artifactVersions.push({
    artifactId: 1,
    version: 2,
    createdAt: new Date().toISOString(),
    bytes: 10,
    note: 'Second take.',
  })
  api.db.artifactHtml['1/2'] = '<!doctype html><p>v2</p>'
  wrapper = mount(ArtifactFrame, {
    props: { artifactId: 1, version: 2, title: 'Pick a History layout' },
    global: { provide: { [API_KEY as symbol]: api } },
    attachTo: document.body,
  })
  await flushPromises()
  // the iframe has no real window in the test DOM: give it one we can speak as
  const iframe = wrapper.find('iframe').element as HTMLIFrameElement
  const own = {}
  Object.defineProperty(iframe, 'contentWindow', { value: own, configurable: true })
  const say = (data: unknown, source: unknown = own) =>
    window.dispatchEvent(
      new MessageEvent('message', { data, source: source as MessageEventSource }),
    )
  const submit = (data: unknown = { choice: 'A' }, over: object = {}) =>
    say({ type: 'odin.submit', artifactId: 1, version: 2, data, ...over })
  return { api, iframe, own, say, submit }
}

const dialogOpen = () => document.querySelector('dialog')?.hasAttribute('open')
const buttons = () => [...document.querySelectorAll('dialog button')] as HTMLButtonElement[]
const answers = async (api: ReturnType<typeof createMockApi>) =>
  (await api.getSession(FIXTURE_SESSION_IDS.idle)).transcript.filter(
    e => e.kind === 'user' && e.text.startsWith('Answer from'),
  )

describe('ArtifactFrame', () => {
  it('embeds the artifact in a sandbox that never shares the app origin', async () => {
    const { api, iframe } = await mountFrame()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-forms')
    expect(iframe.getAttribute('src')).toBe(api.artifactUrl(1, 2))
    // nothing but its own URL: no inline document
    expect(iframe.getAttributeNames().sort()).toEqual(['class', 'sandbox', 'src', 'title'])
  })

  it('shows the version it is given, with a fresh frame per version', async () => {
    const { api, iframe } = await mountFrame()
    await wrapper!.setProps({ version: 1 })
    expect(wrapper!.find('iframe').attributes('src')).toBe(api.artifactUrl(1, 1))
    expect(wrapper!.find('iframe').element).not.toBe(iframe)
  })

  it('asks before sending, then submits the answer into the session', async () => {
    const { api, submit } = await mountFrame()
    submit({ choice: 'A' })
    await flushPromises()
    expect(dialogOpen()).toBe(true)
    expect(document.querySelector('dialog')?.textContent).toContain(
      'Send your answer to the session?',
    )
    expect(document.querySelector('dialog')?.textContent).toContain('"choice": "A"')
    expect(await answers(api)).toHaveLength(0)

    buttons()
      .find(b => b.textContent?.includes('Send answer'))!
      .click()
    await flushPromises()
    const sent = await answers(api)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.kind === 'user' && sent[0]!.text).toContain('"choice": "A"')
    expect(wrapper!.emitted('answered')).toHaveLength(1)
  })

  it('sends nothing when the user cancels', async () => {
    const { api, submit } = await mountFrame()
    submit()
    await flushPromises()
    buttons()
      .find(b => b.textContent?.includes('Cancel'))!
      .click()
    await flushPromises()
    expect(await answers(api)).toHaveLength(0)
    expect(wrapper!.emitted('answered')).toBeUndefined()
  })

  it('ignores messages from any window but its own iframe', async () => {
    const { say } = await mountFrame()
    // a sibling frame, the page itself, and a message with no source
    for (const source of [{}, window, null])
      say({ type: 'odin.submit', artifactId: 1, version: 2, data: { choice: 'evil' } }, source)
    await flushPromises()
    expect(dialogOpen()).toBeFalsy()
    expect(document.querySelector('dialog')?.textContent).not.toContain('evil')
  })

  it('ignores the wrong artifact, version, type and oversized data', async () => {
    const { submit } = await mountFrame()
    submit({ a: 1 }, { artifactId: 2 })
    submit({ a: 1 }, { version: 1 })
    submit({ a: 1 }, { type: 'odin.other' })
    submit('x'.repeat(70_000))
    await flushPromises()
    expect(dialogOpen()).toBeFalsy()
  })

  it('stops listening when it is removed', async () => {
    const { submit } = await mountFrame()
    wrapper!.unmount()
    submit()
    await flushPromises()
    expect(dialogOpen()).toBeFalsy()
  })
})
