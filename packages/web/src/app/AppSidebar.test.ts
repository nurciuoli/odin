import { expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { IuNavGroup } from '@/components/Sidebar'
import { IuFlock } from '@/components/Spinner'
import { IuStatusDot } from '@/components/StatusDot'
import { mountScreen } from '@/screens/shared/testSupport'
import { buildPerch } from '@/screens/shared/lanes'
import AppSidebar from './AppSidebar.vue'
import { markAllSeen, markSeen, resetSeen } from './seen'

const SIDEBAR_KEY = 'odin.sidebar.collapsed'

it('puts a collapsible Sessions group after Projects with global navigation and conversations', async () => {
  const { wrapper, projects, sessions } = await mountScreen(AppSidebar, '/sessions')
  await flushPromises()
  const groups = wrapper.findAllComponents(IuNavGroup)
  expect(groups.map(g => g.props('label'))).toEqual(['Projects', 'Sessions'])
  const group = groups[1]!
  expect(group.text()).toContain('All sessions')
  expect(group.findAll('a[href^="/s/"]').length).toBeGreaterThan(0)
  const toggle = group.find('button[aria-expanded]')
  await toggle.trigger('click')
  expect(toggle.attributes('aria-expanded')).toBe('false')
  await toggle.trigger('click')
  expect(toggle.attributes('aria-expanded')).toBe('true')
  wrapper.unmount()
  projects.stop()
  sessions.stop()
})

it('puts Add project as an icon button in the Projects header, not in the footer', async () => {
  const { wrapper, router, projects, sessions } = await mountScreen(AppSidebar, '/')
  await flushPromises()
  const group = wrapper.findAllComponents(IuNavGroup)[0]!
  const toggle = group.find('button[aria-expanded]')
  const add = group.find('[aria-label="Add project"]')
  expect(add.exists()).toBe(true)
  expect(add.attributes('title')).toBe('Add project')
  expect(add.attributes('href')).toBe('/projects/new')
  // A sibling of the collapse toggle, never nested inside it.
  expect(toggle.find('[aria-label="Add project"]').exists()).toBe(false)
  expect(wrapper.findAll('[aria-label="Add project"]')).toHaveLength(1)
  expect(wrapper.text()).not.toContain('Add project')

  await add.trigger('click')
  await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('add-project'))
  expect(toggle.attributes('aria-expanded')).toBe('true')
  wrapper.unmount()
  projects.stop()
  sessions.stop()
})

it('provides a labeled width toggle and restores the desktop preference', async () => {
  localStorage.removeItem(SIDEBAR_KEY)
  const first = await mountScreen(AppSidebar, '/')
  await flushPromises()
  expect(first.wrapper.find('.iu-sidebar').attributes('style')).toContain('288px')
  const toggle = first.wrapper.find('button[aria-label="Collapse sidebar"]')
  expect(toggle.attributes('aria-expanded')).toBe('true')
  await toggle.trigger('click')
  expect(localStorage.getItem(SIDEBAR_KEY)).toBe('true')
  expect(first.wrapper.find('.iu-sidebar').classes()).toContain('is-collapsed')
  first.wrapper.unmount()
  first.projects.stop()
  first.sessions.stop()

  const second = await mountScreen(AppSidebar, '/')
  await flushPromises()
  expect(second.wrapper.find('.iu-sidebar').classes()).toContain('is-collapsed')
  expect(second.wrapper.find('button[aria-label="Expand sidebar"]').exists()).toBe(true)
  second.wrapper.unmount()
  second.projects.stop()
  second.sessions.stop()
  localStorage.removeItem(SIDEBAR_KEY)
})

it('splits composer rows from quiet finished rows and uses Home flock states', async () => {
  localStorage.removeItem(SIDEBAR_KEY)
  const { wrapper, projects, sessions, api } = await mountScreen(AppSidebar, '/sessions')
  await flushPromises()
  markAllSeen(sessions.sidebar.value)
  await flushPromises()
  const rows = wrapper.findAll('.app-nav-slot').filter(r => r.find('a[href^="/s/"]').exists())
  const named = (state: string) =>
    rows.filter(r => r.find('a').attributes('aria-label')?.endsWith(`, ${state}`))
  const running = named('Running')
  const waiting = named('Needs you')
  expect(running.length).toBeGreaterThan(0)
  expect(waiting.length).toBeGreaterThan(0)
  for (const [list, state] of [
    [running, 'working'],
    [waiting, 'waiting'],
  ] as const) {
    for (const row of list) {
      const flock = row.findComponent(IuFlock)
      const id = row.find('a').attributes('href')!.split('/').pop()!
      const detail = await api.getSession(id)
      const perch = buildPerch({ detail, work: sessions.workOf(id) }, Date.now())
      expect(flock.props()).toMatchObject({
        state: state === 'waiting' ? 'waiting' : perch.flock,
        size: 'sm',
        tone: 'neutral',
        agents: perch.agents,
      })
      expect(row.find('.app-session-row__project').exists()).toBe(true)
      expect(row.find('time').attributes('datetime')).toBe(detail.updatedAt)
      // decorative: the link's name says the state
      expect(flock.attributes('aria-hidden')).toBe('true')
      expect(flock.attributes('role')).toBeUndefined()
      expect(row.findComponent(IuStatusDot).exists()).toBe(false)
    }
  }
  const rest = rows.filter(r => !running.includes(r) && !waiting.includes(r))
  expect(rest.length).toBeGreaterThan(0)
  for (const row of rest) {
    expect(row.findComponent(IuFlock).exists()).toBe(false)
    expect(row.findComponent(IuStatusDot).exists()).toBe(false)
    expect(row.find('.iu-nav-item__description').exists()).toBe(false)
  }
  const progress = wrapper.find('section[aria-label="In progress"]')
  const finished = wrapper.find('section[aria-label="Finished / read"]')
  expect(progress.findAll('a').length).toBe(running.length + waiting.length)
  expect(finished.findAll('a').length).toBe(rest.length)
  const runningSession = sessions.sidebar.value.find(s => s.state === 'running')!
  api.emit({
    type: 'session.event',
    sessionId: runningSession.id,
    event: {
      type: 'entry',
      entry: {
        kind: 'tool',
        id: 'sidebar-live-read',
        parentToolUseId: null,
        name: 'Read',
        input: { file_path: '/project/sidebar.vue' },
        at: new Date().toISOString(),
      },
    },
  })
  await flushPromises()
  const runningRow = progress.find(`a[href="/s/${runningSession.id}"]`)
  expect(runningRow.attributes('aria-label')).toContain('Reading sidebar.vue')
  expect(runningRow.findComponent(IuFlock).props('state')).toBe('working')
  const session = sessions.sidebar.value.find(s => s.state === 'waiting')!
  api.emit({
    type: 'session.updated',
    session: { ...JSON.parse(JSON.stringify(session)), state: 'idle' },
  })
  await flushPromises()
  expect(progress.find(`a[href="/s/${session.id}"]`).exists()).toBe(false)
  expect(finished.find(`a[href="/s/${session.id}"]`).exists()).toBe(true)
  wrapper.unmount()
  projects.stop()
  sessions.stop()
})

it('perches the waiting count on the Sessions icon of the collapsed rail only while sessions wait', async () => {
  localStorage.setItem(SIDEBAR_KEY, 'true')
  const api = createMockApi()
  const { wrapper, projects, sessions } = await mountScreen(AppSidebar, '/', api)
  await flushPromises()
  const n = sessions.waiting.value.length
  expect(n).toBeGreaterThan(0)
  const all = () => wrapper.find('a[href="/sessions"]')
  const words = `${n} ${n === 1 ? 'session needs' : 'sessions need'} you`
  expect(wrapper.find('.app-nav-slot__count').text()).toBe(String(n))
  expect(all().attributes('aria-label')).toBe(`All sessions, ${words}`)

  // expanded: the rows themselves show who waits
  await wrapper.find('button[aria-label="Expand sidebar"]').trigger('click')
  expect(wrapper.find('.app-nav-slot__count').exists()).toBe(false)
  await wrapper.find('button[aria-label="Collapse sidebar"]').trigger('click')
  expect(wrapper.find('.app-nav-slot__count').exists()).toBe(true)

  for (const s of sessions.waiting.value)
    api.emit({
      type: 'session.updated',
      session: { ...JSON.parse(JSON.stringify(s)), state: 'idle' },
    })
  await flushPromises()
  expect(wrapper.find('.app-nav-slot__count').exists()).toBe(false)
  expect(all().attributes('aria-label')).toBeUndefined()
  wrapper.unmount()
  projects.stop()
  sessions.stop()
  localStorage.removeItem(SIDEBAR_KEY)
})

it('renames a session from its sidebar menu without navigating', async () => {
  localStorage.removeItem(SIDEBAR_KEY)
  const api = createMockApi()
  const update = vi.spyOn(api, 'updateSession')
  const { wrapper, router, projects, sessions } = await mountScreen(AppSidebar, '/sessions', api)
  await flushPromises()
  const session = sessions.sidebar.value[0]!
  expect(wrapper.find('button[aria-label^="Actions for"]').exists()).toBe(false)
  await wrapper
    .find(`a[href="/s/${session.id}"]`)
    .trigger('contextmenu', { clientX: 100, clientY: 200 })
  await wrapper
    .findAll('[role="menuitem"]')
    .find(item => item.text().includes('Rename'))!
    .trigger('click')
  await wrapper.find('form#sidebar-rename input').setValue('Sidebar renamed session')
  await wrapper.find('form#sidebar-rename').trigger('submit')
  await flushPromises()
  expect(update).toHaveBeenCalledWith(session.id, { title: 'Sidebar renamed session' })
  expect(wrapper.find(`a[href="/s/${session.id}"]`).text()).toContain('Sidebar renamed session')
  expect(router.currentRoute.value.path).toBe('/sessions')
  wrapper.unmount()
  projects.stop()
  sessions.stop()
})

it('opens session actions by keyboard in the collapsed sidebar', async () => {
  localStorage.setItem(SIDEBAR_KEY, 'true')
  const { wrapper, router, projects, sessions } = await mountScreen(AppSidebar, '/sessions')
  await flushPromises()
  const session = sessions.sidebar.value[0]!
  const link = wrapper.find(`a[href="/s/${session.id}"]`)
  await link.trigger('keydown', { key: 'F10', shiftKey: true })
  await flushPromises()
  expect(link.attributes('aria-expanded')).toBe('true')
  expect(wrapper.find('[role="menu"]').text()).toContain('Rename')
  expect(router.currentRoute.value.path).toBe('/sessions')
  await wrapper.find('[role="menu"]').trigger('keydown', { key: 'Escape' })
  expect(link.attributes('aria-expanded')).toBe('false')
  wrapper.unmount()
  projects.stop()
  sessions.stop()
  localStorage.removeItem(SIDEBAR_KEY)
})

it('deletes the viewed session from its sidebar menu and returns home', async () => {
  localStorage.removeItem(SIDEBAR_KEY)
  const api = createMockApi()
  const remove = vi.spyOn(api, 'deleteSession')
  const { wrapper, router, projects, sessions } = await mountScreen(AppSidebar, '/sessions', api)
  await flushPromises()
  const session = sessions.sidebar.value[0]!
  await router.push(`/s/${session.id}`)
  await wrapper
    .find(`a[href="/s/${session.id}"]`)
    .trigger('contextmenu', { clientX: 100, clientY: 200 })
  await wrapper
    .findAll('[role="menuitem"]')
    .find(item => item.text().includes('Delete'))!
    .trigger('click')
  expect(remove).not.toHaveBeenCalled()
  await wrapper
    .findAll('dialog button')
    .find(button => button.text() === 'Delete')!
    .trigger('click')
  await flushPromises()
  expect(remove).toHaveBeenCalledWith(session.id)
  expect(wrapper.find(`a[href="/s/${session.id}"]`).exists()).toBe(false)
  expect(router.currentRoute.value.path).toBe('/')
  wrapper.unmount()
  projects.stop()
  sessions.stop()
})

it('keeps the session and reports an action failure in the dialog', async () => {
  localStorage.removeItem(SIDEBAR_KEY)
  const api = createMockApi()
  vi.spyOn(api, 'deleteSession').mockRejectedValue(new Error('Could not remove session'))
  const { wrapper, projects, sessions } = await mountScreen(AppSidebar, '/sessions', api)
  await flushPromises()
  const session = sessions.sidebar.value[0]!
  await wrapper
    .find(`a[href="/s/${session.id}"]`)
    .trigger('contextmenu', { clientX: 100, clientY: 200 })
  await wrapper
    .findAll('[role="menuitem"]')
    .find(item => item.text().includes('Delete'))!
    .trigger('click')
  await wrapper
    .findAll('dialog button')
    .find(button => button.text() === 'Delete')!
    .trigger('click')
  await flushPromises()
  expect(wrapper.find('dialog').text()).toContain('Could not remove session')
  expect(wrapper.find(`a[href="/s/${session.id}"]`).exists()).toBe(true)
  wrapper.unmount()
  projects.stop()
  sessions.stop()
})

it('keeps recently finished unopened sessions in progress until read, with project summaries', async () => {
  resetSeen()
  localStorage.removeItem(SIDEBAR_KEY)
  const { wrapper, projects, sessions, api } = await mountScreen(AppSidebar, '/sessions')
  await flushPromises()
  const session = sessions.sidebar.value.find(s => s.state === 'waiting')!
  const finishedSession = {
    ...JSON.parse(JSON.stringify(session)),
    state: 'ended' as const,
    projects: ['odin', 'other-project'],
    updatedAt: new Date().toISOString(),
  }
  api.emit({ type: 'session.updated', session: finishedSession })
  await flushPromises()
  const progress = () => wrapper.find('section[aria-label="In progress"]')
  const finished = () => wrapper.find('section[aria-label="Finished / read"]')
  const row = progress().find(`a[href="/s/${session.id}"]`)
  expect(row.exists()).toBe(true)
  expect(row.attributes('aria-label')).toContain('Done, not opened yet')
  expect(row.findComponent(IuFlock).props('state')).toBe('idle')
  const projectTitle = projects.projects.value.find(p => p.name === 'odin')!.title
  expect(row.find('.app-session-row__project').text()).toBe(`${projectTitle} +1`)
  expect(row.find('time').attributes('datetime')).toBe(finishedSession.updatedAt)
  expect(finished().find(`a[href="/s/${session.id}"]`).exists()).toBe(false)
  const visible = wrapper.findAll('section a[href^="/s/"]').map(a => a.attributes('href')!.slice(3))
  expect(visible).toEqual(sessions.sidebar.value.map(s => s.id))
  markSeen(finishedSession)
  await flushPromises()
  expect(progress().find(`a[href="/s/${session.id}"]`).exists()).toBe(false)
  expect(finished().find(`a[href="/s/${session.id}"]`).exists()).toBe(true)
  wrapper.unmount()
  projects.stop()
  sessions.stop()
  resetSeen()
})
