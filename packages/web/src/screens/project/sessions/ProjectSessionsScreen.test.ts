import { expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import ProjectSessionsScreen from './ProjectSessionsScreen.vue'

it('shows project-related sessions without a composer or Start chat', async () => {
  const { wrapper } = await mountProjectScreen(ProjectSessionsScreen, '/p/odin/sessions')
  await flushPromises()
  expect(wrapper.find('textarea').exists()).toBe(false)
  expect(wrapper.text()).toContain('Sessions')
  expect(wrapper.findAll('a').some(a => a.text() === 'Start chat')).toBe(false)
  expect(wrapper.text()).toContain('Branches')
  wrapper.unmount()
})
