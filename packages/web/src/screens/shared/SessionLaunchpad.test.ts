import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { markSeen, resetSeen } from '@/app/seen'
import ComposerChoice from './ComposerChoice.vue'
import ComposerProjects from './ComposerProjects.vue'
import SessionLaunchpad from './SessionLaunchpad.vue'
import { mountScreen } from './testSupport'

const readAll = async (api: ReturnType<typeof createMockApi>) =>
  (await api.listSessions({ archived: false })).forEach(markSeen)

describe('SessionLaunchpad', () => {
  afterEach(() => resetSeen())

  it('puts the composer first, then sessions in progress as perches, then earlier ones', async () => {
    const api = createMockApi()
    await readAll(api)
    const { wrapper } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()
    expect(wrapper.find('h1').exists()).toBe(false)
    const textarea = wrapper.find('textarea').element
    const progress = wrapper.find('#launchpad-progress').element
    const earlier = wrapper.find('#launchpad-recent').element
    expect(progress.textContent).toBe('In progress')
    expect(earlier.textContent).toBe('Earlier')
    expect(
      textarea.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(
      progress.compareDocumentPosition(earlier) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    const rows = wrapper.findAll('.launchpad__perch')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.attributes('data-state')).toBe('paused')
    expect(rows[0]!.find('.launchpad__perch-word').text()).toMatch(/^Needs you/)
    expect(rows[0]!.text()).toContain('Wants to run rm -rf packages/web/dist')
    expect(rows[0]!.find('.iu-flock').classes()).toEqual(
      expect.arrayContaining(['iu-flock--xl', 'iu-flock--neutral', 'iu-flock--waiting']),
    )
    expect(rows[0]!.find('[role="img"]').attributes('aria-label')).toMatch(/paused for/)
    expect(rows[0]!.find('a.launchpad__perch-title').attributes('href')).toBe(
      `/s/${FIXTURE_SESSION_IDS.waiting}`,
    )
    // the activity sits left of the state word, which stays the right edge of the line
    const activity = rows[1]!.find('.launchpad__perch-activity').element
    const word = rows[1]!.find('.launchpad__perch-word').element
    expect(activity.compareDocumentPosition(word) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(rows[1]!.find('.launchpad__perch-word').text()).toBe('Running')
    expect(rows[1]!.find('.iu-flock').classes()).not.toContain('iu-flock--waiting')
    expect(wrapper.text()).toContain('2 sessions, 1 needs you')
    expect(wrapper.text()).not.toContain('Workspace statistics')
    expect(wrapper.findAllComponents(ComposerChoice).map(c => c.props('label'))).toContain(
      'Harness',
    )
  })

  it('answers a paused session from its row with the prompt API', async () => {
    const api = createMockApi()
    const answer = vi.spyOn(api, 'answerPermission')
    const { wrapper } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()
    const allow = wrapper.findAll('button').find(b => b.text() === 'Allow')!
    expect(allow.attributes('aria-label')).toContain('Permission prompt component')
    await allow.trigger('click')
    await flushPromises()
    expect(answer).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.waiting, 'perm-w4', {
      behavior: 'allow',
      scope: 'once',
    })
    // the queued question is next: it is answered in the session
    await vi.waitFor(() => expect(wrapper.findAll('a').some(a => a.text() === 'Answer')).toBe(true))
  })

  it('keeps the session overview global when selecting a project', async () => {
    const api = createMockApi()
    await readAll(api)
    const list = vi.spyOn(api, 'listSessions')
    const { wrapper } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()
    wrapper.findComponent(ComposerProjects).vm.$emit('update:modelValue', 'odin')
    await flushPromises()
    expect(list).toHaveBeenCalledWith({ archived: false })
    expect(wrapper.find('.launchpad__resources').exists()).toBe(false)
    const rows = wrapper.findAll('.launchpad__session')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some(row => row.text().includes('Odin'))).toBe(true)
    const children = rows[0]!.element.children
    expect(children[0]!.classList.contains('launchpad__session-title')).toBe(true)
    expect(children[1]!.classList.contains('launchpad__session-meta')).toBe(true)
    expect(children[1]!.textContent).not.toMatch(/Idle|Running|Waiting/)
  })

  it('preselects the project from Start chat while retaining the global overview', async () => {
    const { wrapper } = await mountScreen(SessionLaunchpad, '/?project=rick&launch=1')
    await flushPromises()
    expect(wrapper.findComponent(ComposerProjects).props('modelValue')).toBe('rick')
    expect(wrapper.findComponent(ComposerProjects).props('projects')).toEqual(['rick'])
    expect(wrapper.text()).toContain('In progress')
  })

  it('shows a roost when nothing is in progress', async () => {
    const api = createMockApi()
    const list = api.listSessions.bind(api)
    api.listSessions = async q =>
      (await list(q)).filter(s => s.state !== 'running' && s.state !== 'waiting')
    await readAll(api)
    const { wrapper } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()
    const roost = wrapper.find('.launchpad__roost')
    expect(roost.text()).toBe('All quiet. Sessions you start gather here.')
    expect(roost.find('.iu-flock').classes()).toContain('iu-flock--idle')
    expect(wrapper.find('.launchpad__perch').exists()).toBe(false)
  })

  it('reports session failures without claiming the workspace is empty', async () => {
    const api = createMockApi()
    api.listSessions = async () => {
      throw new Error('Unavailable')
    }
    const { wrapper } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()
    expect(wrapper.text()).toContain("Couldn't load ongoing sessions")
    expect(wrapper.text()).toContain("Couldn't load sessions")
    expect(wrapper.text()).not.toContain('All quiet.')
  })

  it('puts unopened idle sessions above live rows in this section', async () => {
    const api = createMockApi()
    const { wrapper } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()
    const titles = wrapper.findAll('.launchpad__perch-title').map(row => row.text())
    const idle = titles.indexOf('Why is history search slow?')
    const running = titles.indexOf('Session screen: streaming chat')
    const failed = titles.indexOf('Try the Electron packaging')
    expect(idle).toBeGreaterThanOrEqual(0)
    expect(idle).toBeLessThan(running)
    expect(failed).toBeGreaterThan(running)
    const idleRow = wrapper.findAll('.launchpad__perch')[idle]!
    expect(idleRow.text()).toContain('Not opened yet')
    expect(idleRow.find('.iu-flock').classes()).toContain('iu-flock--idle')
  })

  it('keeps a finished session you have not opened with the active ones, until you open it', async () => {
    const api = createMockApi()
    const { wrapper } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()
    const finished = wrapper.findAll('.launchpad__perch--finished')
    expect(finished.length).toBeGreaterThan(0)
    expect(finished[0]!.text()).toContain('Not opened yet')
    expect(finished[0]!.find('.iu-flock').classes()).toContain('iu-flock--xl')
    expect(finished[0]!.find('.iu-status-dot').exists()).toBe(false)
    const title = finished[0]!.find('a.launchpad__perch-title').text()
    expect(wrapper.find('.launchpad__list').text()).not.toContain(title)
    markSeen((await api.listSessions({ archived: false })).find(s => s.title === title)!)
    await flushPromises()
    expect(wrapper.findAll('.launchpad__perch--finished').length).toBe(finished.length - 1)
  })

  it('shows recently imported history in Earlier until it has new activity', async () => {
    const api = createMockApi()
    const imported = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.external)!
    imported.updatedAt = new Date().toISOString()
    imported.activityAt = null
    imported.lastRunAt = new Date(Date.now() - 5 * 60_000).toISOString()
    const { wrapper, projects, sessions } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()
    const finished = () => wrapper.findAll('.launchpad__perch--finished').map(row => row.text())
    expect(finished().some(row => row.includes(imported.title))).toBe(false)
    expect(wrapper.find('.launchpad__list').text()).toContain(imported.title)
    expect(wrapper.find(`time[datetime="${imported.lastRunAt}"]`).text()).toBe('5m ago')

    imported.activityAt = imported.updatedAt
    imported.lastRunAt = imported.updatedAt
    api.emit({ type: 'session.updated', session: imported })
    await vi.waitFor(() => expect(finished().some(row => row.includes(imported.title))).toBe(true))
    expect(wrapper.find('.launchpad__list').text()).not.toContain(imported.title)
    wrapper.unmount()
    projects.stop()
    sessions.stop()
  })

  it('shows the five newest unread sessions with a control to expand the full list', async () => {
    const api = createMockApi()
    const list = api.listSessions.bind(api)
    api.listSessions = async query => {
      const sessions = await list(query)
      const finished = sessions.find(s => s.state === 'idle')!
      return [
        ...sessions,
        ...Array.from({ length: 7 }, (_, index) => ({
          ...finished,
          id: `unread-${index}`,
          title: `Unread ${index}`,
          updatedAt: new Date(Date.now() + index * 1000).toISOString(),
          activityAt: new Date(Date.now() - index * 1000).toISOString(),
        })),
      ]
    }
    const { wrapper } = await mountScreen(SessionLaunchpad, '/', api)
    await flushPromises()

    expect(wrapper.findAll('.launchpad__perch--finished')).toHaveLength(5)
    const showAll = wrapper.findAll('button').find(button => button.text().startsWith('Show all '))!
    expect(showAll.exists()).toBe(true)
    const unreadCount = Number(showAll.text().match(/\d+/)?.[0])
    await showAll.trigger('click')
    expect(wrapper.findAll('.launchpad__perch--finished')).toHaveLength(unreadCount)
    expect(wrapper.findAll('.launchpad__perch--finished')[0]!.text()).toContain('Unread 0')
    await wrapper
      .findAll('button')
      .find(button => button.text() === 'Show fewer')!
      .trigger('click')
    expect(wrapper.findAll('.launchpad__perch--finished')).toHaveLength(5)
  })
})
