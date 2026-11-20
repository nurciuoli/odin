import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { API_KEY } from '@/api'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createMockApi } from '@/api/mock'
import { mountScreen } from '@/screens/shared/testSupport'
import App from '@/App.vue'
import AppHeader from './AppHeader.vue'
import { createAppRouter } from './router'

let wrapper: VueWrapper | undefined
let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  stop = undefined
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
})

describe('AppHeader', () => {
  it('shows no title on Home and no gear', async () => {
    const mounted = await mountScreen(AppHeader, '/')
    wrapper = mounted.wrapper
    stop = () => (mounted.projects.stop(), mounted.sessions.stop())
    expect(wrapper.find('.iu-breadcrumb').text()).toBe('')
    expect(wrapper.find('[aria-label="Page settings and actions"]').exists()).toBe(false)
  })

  it('links a library asset back to the library and its kind', async () => {
    const mounted = await mountScreen(AppHeader, '/library/mcp/canva-test')
    wrapper = mounted.wrapper
    stop = () => (mounted.projects.stop(), mounted.sessions.stop())
    const links = wrapper.findAll('.iu-breadcrumb a')
    expect(links.map(a => a.text())).toEqual(['Library', 'MCP servers'])
    expect(links[0]!.attributes('href')).toBe('/library')
    expect(links[1]!.attributes('href')).toBe('/library?kind=mcp')
    expect(wrapper.find('.iu-breadcrumb__current').text()).toBe('canva-test')
  })

  it("leaves a project page's band to the project's own one-line header", async () => {
    const mounted = await mountScreen(AppHeader, '/p/odin/sessions')
    wrapper = mounted.wrapper
    stop = () => (mounted.projects.stop(), mounted.sessions.stop())
    await flushPromises()
    expect(wrapper.find('.iu-breadcrumb').exists()).toBe(false)
    expect(wrapper.find('#app-header-project').exists()).toBe(true)
  })
})

describe('App layout', () => {
  async function mountApp(path: string) {
    const router = createAppRouter(createMemoryHistory())
    await router.push(path)
    await router.isReady()
    wrapper = mount(App, {
      attachTo: document.body,
      global: { plugins: [router], provide: { [API_KEY as symbol]: createMockApi() } },
    })
    await flushPromises()
    return wrapper
  }

  it("puts a project's title, branch and actions in the header band on one line", async () => {
    await mountApp('/p/odin/overview')
    const band = wrapper!.find('.iu-shell__header')
    expect(band.find('.phdr__title').text()).toBe('Odin')
    expect(band.text()).toContain('Start chat')
    expect(wrapper!.findAll('.phdr')).toHaveLength(1)
  })

  it('puts the title in the rail and the page header over the centre column', async () => {
    await mountApp('/')
    expect(wrapper!.find('.iu-sidebar .app-wordmark').text()).toContain('odin')
    expect(wrapper!.find('.iu-shell__header').exists()).toBe(true)
    expect(wrapper!.find('.iu-shell__content--flush').exists()).toBe(false)
  })

  it('lets a session draw its own column headers edge to edge', async () => {
    await mountApp(`/s/${FIXTURE_SESSION_IDS.idle}`)
    await flushPromises()
    expect(wrapper!.find('.iu-shell__header').exists()).toBe(false)
    expect(wrapper!.find('.iu-shell__content--flush').exists()).toBe(true)
  })
})
