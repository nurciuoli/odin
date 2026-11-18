import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createMockApi } from '@/api/mock'
import { useCommands } from '@/app/commands'
import { mountScreen } from '@/screens/shared/testSupport'
import SessionHeader from './SessionHeader.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

async function mountHeader(id: string) {
  const api = createMockApi()
  const session = await api.getSession(id)
  const ctx = await mountScreen(SessionHeader, `/s/${id}`, api, { session })
  await flushPromises()
  return ctx
}

it('shows how many other sessions wait, and answers a tool prompt from the list', async () => {
  const { wrapper, api, sessions, projects } = await mountHeader(FIXTURE_SESSION_IDS.running)
  const chip = wrapper.find('.session-header__waiting')
  expect(chip.text()).toContain('1 waiting')
  expect(chip.attributes('aria-label')).toBe('1 other session needs you. Show them')
  expect(wrapper.find('[role="status"]').text()).toBe('1 other session needs you')

  await chip.trigger('click')
  await flushPromises()
  const row = wrapper
    .findAll('[role="menuitem"]')
    .find(b => b.text().includes('Permission prompt component'))!
  expect(row.text()).toContain('Claude wants to')
  const answer = vi.spyOn(api, 'answerPermission')
  const allow = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    b => b.textContent?.trim() === 'Allow once',
  )!
  allow.click()
  await flushPromises()
  expect(answer).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.waiting, 'perm-w4', {
    behavior: 'allow',
    scope: 'once',
  })
  wrapper.unmount()
  sessions.stop()
  projects.stop()
})

it('has no chip on the waiting session itself, and offers Fork to the palette while mounted', async () => {
  const { wrapper, sessions, projects } = await mountHeader(FIXTURE_SESSION_IDS.waiting)
  expect(wrapper.find('.session-header__waiting').exists()).toBe(false)
  expect(useCommands().value.map(c => c.id)).toContain('session-fork')
  wrapper.unmount()
  expect(useCommands().value.map(c => c.id)).not.toContain('session-fork')
  sessions.stop()
  projects.stop()
})
