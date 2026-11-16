import { expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { IuFlock } from '@/components/Spinner'
import { mountScreen } from './testSupport'
import SessionsTable from './SessionsTable.vue'

it('shows the flock in running and waiting rows only, beside the state label', async () => {
  const api = createMockApi()
  const list = await api.listSessions({ archived: false })
  const { wrapper, projects, sessions } = await mountScreen(SessionsTable, '/sessions', api, {
    sessions: list,
  })
  await flushPromises()
  const expected = { running: 'working', waiting: 'waiting' } as const
  const states = new Set(list.map(s => s.state))
  expect(states.has('running') && states.has('waiting')).toBe(true)
  expect([...states].some(s => !(s in expected))).toBe(true)

  for (const s of list) {
    const row = wrapper.findAll('tbody tr').find(r => r.find(`a[href="/s/${s.id}"]`).exists())!
    const badge = row.find('.iu-badge--status')
    const flock = badge.findComponent(IuFlock)
    const state = (expected as Record<string, string>)[s.state]
    if (state) {
      expect(flock.props()).toMatchObject({ state, size: 'sm', tone: 'neutral' })
      expect(flock.attributes('aria-hidden')).toBe('true')
      expect(badge.find('.iu-badge__dot').exists()).toBe(false)
      // never the only signal
      expect(badge.text()).not.toBe('')
    } else {
      expect(flock.exists()).toBe(false)
      expect(badge.find('.iu-badge__dot').exists()).toBe(true)
    }
  }
  expect(wrapper.findAllComponents(IuFlock)).toHaveLength(
    list.filter(s => s.state in expected).length,
  )
  wrapper.unmount()
  projects.stop()
  sessions.stop()
})
