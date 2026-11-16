import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { IuFilterBar } from '@/components/FilterBar'
import HistoryScreen from './HistoryScreen.vue'
import { createMockApi } from '@/api/mock'
import { mountScreen } from '@/screens/shared/testSupport'

const rowTitles = (w: { findAll: (s: string) => { text: () => string }[] }) =>
  w.findAll('tbody tr').map(r => r.text())

describe('HistoryScreen', () => {
  it('lists the sessions of every project', async () => {
    const { wrapper } = await mountScreen(HistoryScreen, '/history')
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Session screen: streaming chat')
    expect(text).toContain('Port the GitHub client')
    expect(wrapper.find('thead').text()).toContain('Tokens out')
  })

  it('reads the filters from the URL', async () => {
    const { wrapper } = await mountScreen(HistoryScreen, '/history?f=state:is:failed')
    await flushPromises()
    const rows = rowTitles(wrapper)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.join(' ')).toContain('Try the Electron packaging')
    expect(rows.join(' ')).not.toContain('Port the GitHub client')
    expect(wrapper.text()).toContain('State')
  })

  it('writes filter changes back to the URL', async () => {
    const { wrapper, router } = await mountScreen(HistoryScreen, '/history')
    await flushPromises()
    wrapper
      .findComponent(IuFilterBar)
      .vm.$emit('update:modelValue', [{ key: 'project', op: 'is', value: ['rick'] }])
    await flushPromises()
    expect(router.currentRoute.value.query.f).toEqual(['project:is:rick'])
    const titles = rowTitles(wrapper).join(' ')
    expect(titles).toContain('Port the GitHub client')
    expect(titles).not.toContain('Session screen')
  })

  it('follows the URL when it changes under it', async () => {
    const { wrapper, router } = await mountScreen(HistoryScreen, '/history')
    await flushPromises()
    await router.push('/history?f=project:is:rick')
    await flushPromises()
    expect(rowTitles(wrapper).join(' ')).not.toContain('Session screen')
  })

  it('shows the archived sessions with the switch', async () => {
    const { wrapper, router } = await mountScreen(HistoryScreen, '/history?archived=1')
    await flushPromises()
    expect(router.currentRoute.value.query.archived).toBe('1')
    expect(wrapper.text()).toContain('including archived')
  })

  it('says so when a filter matches nothing', async () => {
    const { wrapper } = await mountScreen(HistoryScreen, '/history?q=zzzznomatch')
    await flushPromises()
    expect(wrapper.text()).toContain('No sessions match')
  })

  it('shows the error with a retry when the list fails', async () => {
    const api = createMockApi()
    api.listSessions = () => Promise.reject(new Error('boom'))
    const { wrapper } = await mountScreen(HistoryScreen, '/history', api)
    await flushPromises()
    expect(wrapper.text()).toContain("Couldn't load the history")
    expect(wrapper.text()).toContain('boom')
    const retry = wrapper.findAll('button').find(b => /retry/i.test(b.text()))
    expect(retry).toBeTruthy()
  })
})
