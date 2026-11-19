import { afterEach, expect, it } from 'vitest'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import OverviewScreen from './OverviewScreen.vue'

const headings = (w: VueWrapper) => w.findAll('h2').map(h => h.text())
const spanOf = (w: VueWrapper, id: string) =>
  (w.find(`[aria-labelledby="${id}"]`).element as HTMLElement).style.getPropertyValue('--ov-span')

afterEach(() => localStorage.clear())

it('shows every panel for a git project with GitHub sync, in the planned order', async () => {
  const { wrapper } = await mountProjectScreen(OverviewScreen, '/p/odin/overview')
  await flushPromises()
  expect(headings(wrapper)).toEqual([
    'Totals for the range',
    'Sessions per day',
    'Project',
    'Sessions',
    'Models',
    'Typical session',
    'Code changed by sessions',
    'Branches',
    'Pull requests',
    'Where things stand',
    'Planning',
    'Latest outputs',
  ])
  expect(wrapper.text()).toContain('Lines changed')
  expect(wrapper.text()).toContain('Commits')
  expect(spanOf(wrapper, 'overview-sessions')).toBe('7')
  expect(spanOf(wrapper, 'overview-code')).toBe('8')
  wrapper.unmount()
})

it('leaves out git and GitHub panels and wording for a plain folder, widening their partners', async () => {
  const { wrapper } = await mountProjectScreen(
    OverviewScreen,
    '/p/rick/overview',
    createMockApi(),
    'rick',
  )
  await flushPromises()
  expect(headings(wrapper)).toEqual([
    'Totals for the range',
    'Sessions per day',
    'Project',
    'Sessions',
    'Models',
    'Typical session',
    'Latest outputs',
  ])
  // session titles are the user's own words ("Port the GitHub client"); the page's own labels carry no git wording
  for (const s of wrapper.findAll('.ov-sessions__link')) s.element.textContent = ''
  const text = wrapper.text().toLowerCase()
  for (const word of ['commit', 'branch', 'github', 'pull request', 'lines changed', 'remote'])
    expect(text).not.toContain(word)
  expect(spanOf(wrapper, 'overview-typical')).toBe('12')
  expect(spanOf(wrapper, 'overview-outputs')).toBe('12')
  wrapper.unmount()
})

it('shows a project with no sessions without session breakdowns', async () => {
  const { wrapper } = await mountProjectScreen(
    OverviewScreen,
    '/p/harbor/overview',
    createMockApi(),
    'harbor',
  )
  await flushPromises()
  const h = headings(wrapper)
  expect(h).not.toContain('Models')
  expect(h).not.toContain('Typical session')
  expect(h).not.toContain('Pull requests')
  expect(h).toContain('Code changed by sessions')
  expect(spanOf(wrapper, 'overview-sessions')).toBe('12')
  expect(spanOf(wrapper, 'overview-code')).toBe('12')
  expect(wrapper.text()).toContain('No sessions yet')
  wrapper.unmount()
})

it('changes the range in one step and remembers it', async () => {
  const { wrapper } = await mountProjectScreen(OverviewScreen, '/p/odin/overview')
  await flushPromises()
  const before = wrapper.find('.overview__span').text()
  const week = wrapper.findAll('[role="radio"]').find(b => b.text() === '7 days')!
  await week.trigger('click')
  await flushPromises()
  expect(wrapper.find('.overview__span').text()).not.toBe(before)
  expect(localStorage.getItem('odin.overview.range')).toBe('7d')
  wrapper.unmount()
})

it('keeps the other panels when the activity call fails', async () => {
  const api = createMockApi()
  api.getProjectActivity = () => Promise.reject(new Error('boom'))
  const { wrapper } = await mountProjectScreen(OverviewScreen, '/p/odin/overview', api)
  await flushPromises()
  expect(wrapper.text()).toContain("Couldn't load the activity")
  expect(headings(wrapper)).toContain('Latest outputs')
  expect(headings(wrapper)).toContain('Models')
  expect(wrapper.text()).not.toContain('Open in Compare')
  wrapper.unmount()
})

it('offers Allow once and Deny on a waiting row', async () => {
  const { wrapper } = await mountProjectScreen(OverviewScreen, '/p/odin/overview')
  await flushPromises()
  const buttons = wrapper.findAll('button').map(b => b.text())
  expect(buttons).toContain('Allow once')
  expect(buttons).toContain('Deny')
  wrapper.unmount()
})

it('does not move focus when sessions update', async () => {
  const { wrapper, api } = await mountProjectScreen(OverviewScreen, '/p/odin/overview')
  await flushPromises()
  const before = document.activeElement
  const [s] = await api.listSessions({ project: 'odin' })
  if (s) await api.updateSession(s.id, { title: 'Renamed' })
  await flushPromises()
  expect(document.activeElement).toBe(before)
  wrapper.unmount()
})
