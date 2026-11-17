import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import { API_KEY } from '@/api'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createMockApi, type MockApi } from '@/api/mock'
import { createAppRouter } from '@/app/router'
import { resetDrafts } from '@/app/drafts'
import { installShortcuts } from '@/app/shortcuts'
import { useCommands } from '@/app/commands'
import { IuPermissionPrompt } from '@/components/PermissionPrompt'
import { IuComposer } from '@/components/Composer'
import SessionScreen from './SessionScreen.vue'
import ForkModal from './ForkModal.vue'
import { IuMarkdownEditor } from '@/components/MarkdownEditor'

let wrapper: VueWrapper | undefined
// A wide window unless a test says otherwise (happy-dom's default 1024px counts as narrow).
let narrowScreen = false
let viewportWidth = 1440
const realMatchMedia = window.matchMedia
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth })
  window.matchMedia = ((query: string) => ({
    matches: narrowScreen && query.includes('max-width'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  document.body.innerHTML = ''
  narrowScreen = false
  viewportWidth = 1440
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth })
  window.matchMedia = realMatchMedia
  window.localStorage.clear()
  resetDrafts()
})

async function mountSession(id: string, api: MockApi = createMockApi()) {
  const router = createAppRouter(createMemoryHistory())
  await router.push(`/s/${id}`)
  await router.isReady()
  wrapper = mount(SessionScreen, {
    props: { id },
    attachTo: document.body,
    global: { plugins: [router], provide: { [API_KEY as symbol]: api } },
  })
  await flushPromises()
  return { api, router, wrapper }
}

const textarea = () => wrapper!.find('textarea[aria-label="Message"]')
const button = (label: string) => wrapper!.findAll('button').find(b => b.text().trim() === label)

describe('SessionScreen', () => {
  it('changes effort from the composer menu and slash command without sending a turn', async () => {
    const api = createMockApi()
    const record = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.idle)!
    api.listModels = async () => [
      {
        value: record.model!,
        displayName: 'Fixture',
        description: '',
        resolved: record.model,
        effortLevels: ['low', 'high'],
      },
    ]
    await mountSession(record.id, api)
    const update = vi.spyOn(api, 'updateSession')
    const send = vi.spyOn(api, 'sendMessage')
    expect(wrapper!.find('[aria-label^="Effort:"]').exists()).toBe(false)
    await button('Fixture')!.trigger('click')
    await flushPromises()
    await wrapper!.find('[role="radio"][aria-label="High"]').trigger('click')
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(record.id, { effort: 'high' })
    const composer = wrapper!.findComponent(IuComposer)
    composer.vm.$emit('submit', { text: '/effort low', attachments: [] })
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(record.id, { effort: 'low' })
    composer.vm.$emit('submit', { text: '/effort default', attachments: [] })
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(record.id, { effort: null })
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps the effort across a model change that supports it and resets it otherwise', async () => {
    const api = createMockApi()
    const record = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.idle)!
    record.effort = 'high'
    const info = (value: string, effortLevels?: string[]) => ({
      value,
      displayName: value,
      description: '',
      resolved: value,
      ...(effortLevels ? { effortLevels: effortLevels as never } : {}),
    })
    api.listModels = async () => [
      info(record.model!, ['low', 'high']),
      info('keeps', ['medium', 'high']),
      info('drops', ['low']),
      info('none'),
    ]
    await mountSession(record.id, api)
    const update = vi.spyOn(api, 'updateSession')
    const composer = wrapper!.findComponent(IuComposer)
    composer.vm.$emit('update:modelId', 'keeps')
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(record.id, { model: 'keeps' })
    composer.vm.$emit('update:modelId', 'drops')
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(record.id, { model: 'drops', effort: null })
  })

  it('selects the artifact requested by a deep link', async () => {
    const { api, router } = await mountSession(FIXTURE_SESSION_IDS.idle)
    const artifact = api.db.artifacts.find(a => a.sessionId === FIXTURE_SESSION_IDS.idle)!
    await router.replace({ query: { artifact: String(artifact.id) } })
    await flushPromises()
    expect(wrapper!.find('iframe').attributes('src')).toBe(
      api.artifactUrl(artifact.id, artifact.latestVersion),
    )
    expect(wrapper!.find('.session-workbench').attributes('data-tab')).toBe('artifacts')
  })
  it('closes and reopens the mounted preview, and resizes it with the keyboard', async () => {
    await mountSession(FIXTURE_SESSION_IDS.idle)
    const frame = wrapper!.find('iframe').element
    const splitter = wrapper!.find('[role="separator"][aria-label="Resize content preview"]')
    expect(splitter.attributes('aria-valuenow')).toBe('760')
    await splitter.trigger('keydown', { key: 'ArrowLeft' })
    await flushPromises()
    expect(wrapper!.find('[role="separator"]').attributes('aria-valuenow')).toBe('776')
    expect(wrapper!.find('aside[aria-label="Artifacts"]').attributes('style')).toContain('772px')

    const separator = wrapper!.find('[role="separator"]').element as HTMLElement & {
      setPointerCapture: (id: number) => void
      hasPointerCapture: (id: number) => boolean
      releasePointerCapture: (id: number) => void
    }
    separator.setPointerCapture = vi.fn()
    separator.hasPointerCapture = vi.fn(() => true)
    separator.releasePointerCapture = vi.fn()
    await wrapper!.find('[role="separator"]').trigger('pointerdown', {
      button: 0,
      pointerId: 7,
      clientX: 1000,
    })
    expect(wrapper!.find('.session-workbench__drag-shield').exists()).toBe(true)
    await wrapper!.find('[role="separator"]').trigger('pointermove', { pointerId: 7, clientX: 900 })
    expect(wrapper!.find('[role="separator"]').attributes('aria-valuenow')).toBe('876')
    await wrapper!.find('[role="separator"]').trigger('pointercancel', { pointerId: 7 })
    expect(wrapper!.find('.session-workbench__drag-shield').exists()).toBe(false)

    const close = wrapper!.find('[aria-label="Close preview"]')
    await close.trigger('click')
    await flushPromises()
    expect(wrapper!.find('[aria-label="Show preview"]').exists()).toBe(true)
    expect(wrapper!.find('iframe').element).toBe(frame)
    await wrapper!.find('[aria-label="Show preview"]').trigger('click')
    await flushPromises()
    expect(wrapper!.find('iframe').element).toBe(frame)
  })

  it('keeps background work out of the composer and in the details panel', async () => {
    const id = FIXTURE_SESSION_IDS.running
    await mountSession(id)
    expect(wrapper!.find('.iu-activity-strip').exists()).toBe(false)
    // closed details: a quiet count in the header leads there, without moving focus
    const hint = wrapper!.find('.session-screen__running')
    expect(hint.text()).toMatch(/\d+ running/)
    const before = document.activeElement
    await hint.trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(before)
    expect(wrapper!.find('#side-tasks').exists()).toBe(true)
    expect(wrapper!.find('.session-screen__running').exists()).toBe(false)
  })
  it('drops the running count when the last task finishes', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.running
    const command = api.db.transcripts[id]!.find(
      e => e.kind === 'task' && e.task.kind === 'command' && e.task.state === 'running',
    )!
    api.db.transcripts[id] = [command]
    await mountSession(id, api)
    expect(wrapper!.find('.session-screen__running').text()).toContain('1 running')
    if (command.kind !== 'task') throw new Error('Missing command fixture')
    api.harnessEvent(id, { type: 'task', task: { ...command.task, state: 'completed' } })
    await flushPromises()
    expect(wrapper!.find('.session-screen__running').exists()).toBe(false)
  })
  it('focuses an explicitly opened narrow task preview and returns to its selecting row', async () => {
    narrowScreen = true
    await mountSession(FIXTURE_SESSION_IDS.running)
    await wrapper!.find('.session-screen__running').trigger('click')
    await flushPromises()
    const select = wrapper!.find('#side-tasks + ul .session-side__open')
    ;(select.element as HTMLElement).focus()
    await select.trigger('click')
    await flushPromises()
    const dialog = wrapper!.find('[role="dialog"][aria-label="Activity preview"]')
    expect(dialog.attributes('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(dialog.find('button').element)
    await dialog.find('button').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(select.element)
  })
  it('keeps the composer draft through a permission takeover and restores the composer draft', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    const id = FIXTURE_SESSION_IDS.running
    await textarea().setValue('Draft through approval')
    const request = {
      ...structuredClone(api.db.pending[FIXTURE_SESSION_IDS.waiting]![0]!),
      id: 'activity-prompt',
      sessionId: id,
    }
    api.harnessEvent(id, { type: 'permission.request', request })
    await flushPromises()
    expect(wrapper!.find('.session-composer__takeover').exists()).toBe(true)
    expect(textarea().isVisible()).toBe(false)
    api.harnessEvent(id, { type: 'permission.resolved', requestId: request.id, behavior: 'allow' })
    await flushPromises()
    expect(textarea().isVisible()).toBe(true)
    expect((textarea().element as HTMLTextAreaElement).value).toBe('Draft through approval')
  })
  it('preserves a file draft, composer draft and mounted artifact while previewing a child', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.idle
    const task = api.db.transcripts[FIXTURE_SESSION_IDS.running]!.find(
      e => e.kind === 'task' && e.task.kind === 'agent',
    )!
    api.db.transcripts[id]!.push(structuredClone(task))
    await mountSession(id, api)
    const frame = wrapper!.find('iframe').element
    await textarea().setValue('Parent draft')
    await button('Files')!.trigger('click')
    await flushPromises()
    await vi.waitFor(() =>
      expect(
        wrapper!.findAll('.session-files__listing button').some(b => b.text() === 'README.md'),
      ).toBe(true),
    )
    await wrapper!
      .findAll('.session-files__listing button')
      .find(b => b.text() === 'README.md')!
      .trigger('click')
    await flushPromises()
    const editor = wrapper!.findComponent(IuMarkdownEditor)
    editor.vm.$emit('update:modelValue', '# Unsaved parent file')
    await flushPromises()
    await wrapper!.find('[aria-label="Show details"]').trigger('click')
    await flushPromises()
    const select = wrapper!.find('#side-tasks + ul .session-side__open')
    ;(select.element as HTMLElement).focus()
    await select.trigger('click')
    await flushPromises()
    expect(wrapper!.find('.task-preview').text()).toContain('I am reviewing keyboard navigation')
    expect(wrapper!.find('iframe').element).toBe(frame)
    expect(editor.props('modelValue')).toBe('# Unsaved parent file')
    expect((textarea().element as HTMLTextAreaElement).value).toBe('Parent draft')
    await wrapper!.find('.task-preview button').trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(select.element)
    expect(wrapper!.findComponent(IuMarkdownEditor).props('modelValue')).toBe(
      '# Unsaved parent file',
    )
  })
  it('changes live model and mode from the composer while keeping other header actions', async () => {
    const api = createMockApi()
    const record = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.running)!
    record.harness = 'codex'
    record.permissionMode = 'default'
    await mountSession(record.id, api)
    const update = vi.spyOn(api, 'updateSession')
    const composer = wrapper!.findComponent(IuComposer)
    expect(composer.props('minRows')).toBe(2)
    expect(composer.props('models')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'codex-test' })]),
    )
    await textarea().setValue('Keep this draft')
    composer.vm.$emit('update:modelId', 'codex-test')
    await flushPromises()
    expect(update).toHaveBeenCalledWith(record.id, { model: 'codex-test' })
    const mode = () => wrapper!.find('.session-composer button[aria-label^="Permission mode:"]')
    await mode().trigger('click')
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(record.id, { permissionMode: 'acceptEdits' })
    await textarea().trigger('keydown', { key: 'Tab', shiftKey: true })
    await flushPromises()
    expect(update).toHaveBeenLastCalledWith(record.id, { permissionMode: 'plan' })
    expect((textarea().element as HTMLTextAreaElement).value).toBe('Keep this draft')
    await wrapper!.find('[aria-label="Session settings and actions"]').trigger('click')
    const labels = wrapper!.findAll('[role="menuitem"]').map(b => b.text())
    expect(labels).toContain('Fork…')
    expect(labels).toContain('End session')
    expect(labels).not.toContain('Model')
    expect(labels).not.toContain('Permission mode')
  })

  it('changes model and mode on a session that is not live, for its resume', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.ended)
    const update = vi.spyOn(api, 'updateSession')
    const mode = () => wrapper!.find('.session-composer button[aria-label^="Permission mode:"]')
    expect(mode().attributes('disabled')).toBeUndefined()
    expect(wrapper!.findComponent(IuComposer).props('models')?.length).toBeGreaterThan(0)
    await textarea().trigger('keydown', { key: 'Tab', shiftKey: true })
    await flushPromises()
    expect(update).toHaveBeenCalledWith(
      FIXTURE_SESSION_IDS.ended,
      expect.objectContaining({ permissionMode: expect.any(String) }),
    )
    const stored = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.ended)!
    expect(mode().attributes('data-mode')).toBe(stored.permissionMode)
  })
  it('shows a stored failure as a callout unless the thread already says it', async () => {
    const api = createMockApi()
    const stored = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.ended)!
    stored.error = 'the harness stopped'
    await mountSession(FIXTURE_SESSION_IDS.ended, api)
    const callout = wrapper!.find('.session-screen__error')
    expect(callout.exists()).toBe(true)
    expect(callout.text()).toContain('The last turn failed')
    expect(callout.text()).toContain('the harness stopped')
  })
  it('keeps changes in Details with counts and opens the file in the preview', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.waiting)
    expect(wrapper!.find('.session-workbench').isVisible()).toBe(false)
    const session = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.waiting)!
    api.harnessEvent(session.id, {
      type: 'entry',
      entry: {
        kind: 'tool',
        id: 'preview-edit',
        name: 'Edit',
        at: null,
        parentToolUseId: null,
        input: {
          file_path: `${session.cwd}/README.md`,
          old_string: 'before',
          new_string: 'after\nadded',
        },
      },
    })
    await flushPromises()
    await wrapper!.find('[aria-label="Show details"]').trigger('click')
    const row = wrapper!.findAll('.session-side__file').find(f => f.text().includes('README.md'))!
    expect(row.text()).toContain('+2')
    expect(row.text()).toContain('−1')
    const read = vi.spyOn(api, 'readSessionFile')
    await row.find('button').trigger('click')
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith(session.id, 'README.md'))
    expect(wrapper!.find('.session-workbench').isVisible()).toBe(true)
    expect(wrapper!.find('.session-workbench__topbar [role="tablist"]').exists()).toBe(false)
  })
  it('shows tool paths relative to the session working directory', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.idle)
    const session = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.idle)!
    const path = `${session.cwd}/src/review.ts`
    api.harnessEvent(session.id, {
      type: 'entry',
      entry: {
        kind: 'tool',
        id: 'relative-path-review',
        name: 'Read',
        input: { file_path: path },
        at: null,
        parentToolUseId: null,
      },
    })
    await flushPromises()
    const shown = wrapper!
      .findAll('.iu-rail__target .iu-file-path')
      .find(p => p.attributes('title') === path)
    expect(shown?.text()).toBe('src/review.ts')
  })

  it('shows measured usage and uses the runtime context capacity for Codex', async () => {
    const api = createMockApi()
    const record = api.db.sessions.find(s => s.id === FIXTURE_SESSION_IDS.idle)!
    record.harness = 'codex'
    record.model = 'test-codex'
    record.metrics.contextTokens = 100000
    record.metrics.contextWindow = 475000
    record.metrics.tokens = { input: 300, output: 1200, cacheRead: 8000, cacheWrite: 0 }
    record.metrics.turns = 4
    await mountSession(record.id, api)
    const side = wrapper!.find('.session-side')
    expect(side.text()).toContain('100k / 475k')
    expect(side.text()).toContain('1.2k')
    expect(side.text()).toContain('8k')
    expect(side.find('[aria-valuemax="475000"]').exists()).toBe(true)
  })
  it('shows every side section, including empty ones, with the caret after the label', async () => {
    await mountSession(FIXTURE_SESSION_IDS.idle)
    const side = wrapper!.find('.session-side')
    const context = side.find('#side-context button')
    expect(context.element.children[0]?.textContent).toBe('Context')
    expect(context.element.children[1]?.tagName).toBe('svg')
    for (const label of ['Outputs', 'Changes', 'Background tasks', 'Plan', 'Thread', 'Tags']) {
      const summary = side
        .findAll('summary')
        .find(s => s.element.firstElementChild?.textContent === label)
      expect(summary, label).toBeTruthy()
      expect(summary!.element.children[1]?.classList.contains('session-side__caret')).toBe(true)
    }
    expect(side.text()).toContain('No background tasks.')
    expect(side.text()).toContain('No plan yet.')
    const plan = side.find('#side-plan').element.parentElement as HTMLDetailsElement
    expect(plan.open).toBe(false)
    await side.find('#side-plan').trigger('click')
    expect(plan.open).toBe(true)
  })
  it('shows the transcript, the header and the open prompt of a waiting session', async () => {
    await mountSession(FIXTURE_SESSION_IDS.waiting)
    expect(wrapper!.find('h1').text()).toBe('Permission prompt component')
    expect(wrapper!.text()).toContain('Needs you')
    expect(wrapper!.text()).toContain('Build the permission prompt component')
    expect(wrapper!.findComponent(IuPermissionPrompt).exists()).toBe(true)
  })

  it('offers the slash commands from the loaded detail, before any live init', async () => {
    await mountSession(FIXTURE_SESSION_IDS.idle)
    await textarea().setValue('/rev')
    await flushPromises()
    expect(wrapper!.text()).toContain('review')
  })

  it('runs /rename itself with PATCH and never sends it', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.idle)
    const send = vi.spyOn(api, 'sendMessage')
    const update = vi.spyOn(api, 'updateSession')
    await textarea().setValue('/rename Better title')
    await textarea().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(update).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.idle, { title: 'Better title' })
    expect(send).not.toHaveBeenCalled()
  })

  it('puts the waiting prompt in the input area, one at a time, and brings the composer back', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.waiting)
    const takeover = () => wrapper!.find('.session-composer__takeover')
    const composerShown = () => !wrapper!.find('.iu-composer').attributes('style')?.includes('none')
    // the prompt sits in the composer's slot; the message box is hidden, not stacked under it
    expect(takeover().findComponent(IuPermissionPrompt).exists()).toBe(true)
    expect(wrapper!.findAllComponents(IuPermissionPrompt)).toHaveLength(1)
    expect(composerShown()).toBe(false)
    expect(takeover().text()).toContain('1 of 2')
    expect(takeover().text()).toContain('Claude wants to run')
    // no separate Interrupt beside the prompt: the prompt offers Cancel instead
    expect(button('Interrupt')).toBeUndefined()
    expect(wrapper!.find('button[aria-label="Interrupt"]').exists()).toBe(false)
    expect(takeover().find('button[aria-label="Cancel and interrupt the agent"]').exists()).toBe(
      true,
    )

    const spy = vi.spyOn(api, 'answerPermission')
    wrapper!.findComponent(IuPermissionPrompt).vm.$emit('answer', {
      behavior: 'allow',
      scope: 'once',
    })
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.waiting, 'perm-w4', {
      behavior: 'allow',
      scope: 'once',
    })
    // next in the queue: the question, now the only one
    expect(takeover().text()).toContain('Where should the prompt sit?')
    expect(takeover().text()).not.toContain('of 2')
    expect(composerShown()).toBe(false)

    wrapper!.findComponent(IuPermissionPrompt).vm.$emit('answer', {
      behavior: 'allow',
      scope: 'once',
      answers: { 'Where should the prompt sit?': 'In the input area' },
    })
    await flushPromises()
    expect(spy).toHaveBeenLastCalledWith(
      FIXTURE_SESSION_IDS.waiting,
      'perm-w5',
      expect.objectContaining({ behavior: 'allow' }),
    )
    // the mock resolves the last prompt and goes idle; the composer is back and usable
    expect(takeover().exists()).toBe(false)
    expect(composerShown()).toBe(true)
    expect(textarea().attributes('disabled')).toBeUndefined()
    expect(wrapper!.text()).toContain('Idle')
  })

  it('keeps a draft through a prompt that takes over the input area', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.idle)
    await textarea().setValue('half-written thought')
    const id = FIXTURE_SESSION_IDS.idle
    api.harnessEvent(id, {
      type: 'permission.request',
      request: {
        id: 'p-draft',
        sessionId: id,
        kind: 'tool',
        toolName: 'Bash',
        toolUseId: null,
        input: { command: 'ls' },
        title: 'Claude wants to run: ls',
        description: null,
        canAlwaysAllow: true,
        defaultToDeny: true,
        createdAt: new Date().toISOString(),
      },
    })
    api.harnessEvent(id, { type: 'state', state: 'waiting' })
    await flushPromises()
    expect(wrapper!.find('.session-composer__takeover').exists()).toBe(true)
    // a risky prompt that arrived on its own does not grab focus
    expect(document.activeElement?.closest('.session-composer__takeover')).toBeNull()

    api.harnessEvent(id, { type: 'permission.resolved', requestId: 'p-draft', behavior: 'deny' })
    api.harnessEvent(id, { type: 'state', state: 'idle' })
    await flushPromises()
    expect(wrapper!.find('.session-composer__takeover').exists()).toBe(false)
    expect((textarea().element as HTMLTextAreaElement).value).toBe('half-written thought')
  })

  it('starts with the details panel closed and opens it from the header toggle', async () => {
    await mountSession(FIXTURE_SESSION_IDS.idle)
    const panel = () => wrapper!.find('aside[aria-label="Session details"]')
    expect(panel().classes()).toContain('is-closed')
    const toggle = wrapper!.find('[aria-label="Show details"]')
    expect(toggle.attributes('aria-pressed')).toBe('false')
    expect(toggle.attributes('title')).toBe('Show details')
    await toggle.trigger('click')
    expect(panel().classes()).not.toContain('is-closed')
    const workspace = panel().find('[aria-label="Session workspace"]')
    expect(wrapper!.find('.session-side').element.firstElementChild).toBe(workspace.element)
    expect(workspace.find('a[href="/p/odin"]').exists()).toBe(true)
    expect(workspace.find('[aria-label="Branch"]').exists()).toBe(true)
    expect(workspace.text()).not.toContain('claude')
    expect(wrapper!.find('.session-header__meta').exists()).toBe(false)
    const hide = wrapper!.find('[aria-label="Hide details"]')
    expect(hide.attributes('aria-pressed')).toBe('true')
    // remembered for the next session page
    expect(window.localStorage.getItem('odin.session.details')).toBe('open')
  })

  it('announces a new prompt politely without moving focus', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.idle)
    const live = wrapper!.find('.session-screen__announce')
    const focused = document.activeElement
    api.harnessEvent(FIXTURE_SESSION_IDS.idle, {
      type: 'permission.request',
      request: {
        id: 'p-new',
        sessionId: FIXTURE_SESSION_IDS.idle,
        kind: 'tool',
        toolName: 'Bash',
        toolUseId: null,
        input: { command: 'ls' },
        title: 'Claude wants to run: ls',
        description: null,
        canAlwaysAllow: true,
        defaultToDeny: false,
        createdAt: new Date().toISOString(),
      },
    })
    api.harnessEvent(FIXTURE_SESSION_IDS.idle, { type: 'state', state: 'waiting' })
    await flushPromises()
    expect(live.text()).toBe('Needs your answer')
    expect(document.activeElement).toBe(focused)
  })

  it('cancels a pending prompt by interrupting the turn', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.waiting)
    const cancel = wrapper!.find(
      '.session-composer__takeover button[aria-label="Cancel and interrupt the agent"]',
    )
    expect(cancel.text()).toBe('Cancel')
    expect(wrapper!.find('.session-composer__side').exists()).toBe(false)
    const spy = vi.spyOn(api, 'interruptSession')
    const answer = vi.spyOn(api, 'answerPermission')
    await cancel.trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.waiting)
    expect(answer).not.toHaveBeenCalled()
    // the requests resolve as cancelled and the message box comes back
    expect(wrapper!.find('.session-composer__takeover').exists()).toBe(false)
    expect(wrapper!.find('.iu-permission-prompt').exists()).toBe(false)
  })

  it('puts Interrupt in the send spot while running with an empty draft, and interrupts', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    const composer = () => wrapper!.find('.iu-composer')
    const interruptBtn = () => composer().find('button[aria-label="Interrupt"]')
    // inside the composer, not beside it
    expect(interruptBtn().exists()).toBe(true)
    expect(interruptBtn().attributes('title')).toBe('Interrupt')
    expect(composer().find('button[aria-label="Send"]').exists()).toBe(false)
    expect(wrapper!.find('.session-composer__side').exists()).toBe(false)
    expect(button('Interrupt')).toBeUndefined()
    expect(textarea().attributes('disabled')).toBeUndefined()
    // Keep mode cycling on the left and the unfocused pause shortcut on the right.
    const [left, right] = wrapper!.find('.iu-composer__hint').element.children
    expect(left!.textContent).toContain('Shift+Tab change mode')
    expect(right!.textContent).toContain('Esc pause')

    const spy = vi.spyOn(api, 'interruptSession')
    await interruptBtn().trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.running)
    expect(interruptBtn().exists()).toBe(false)
    expect(composer().find('button[aria-label="Send"]').exists()).toBe(true)
    expect(wrapper!.text()).toContain('Interrupted.')
  })

  it('shows the pause shortcut outside typing focus and pauses with Escape while preserving a draft', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    const pause = vi.spyOn(api, 'interruptSession')
    const hint = () => wrapper!.find('.iu-composer__hint-end').text()
    expect(hint()).toBe('Esc pause')
    const input = textarea().element as HTMLTextAreaElement
    input.focus()
    await textarea().setValue('Keep this draft')
    expect(hint()).toContain('↵ send')
    expect(wrapper!.find('.iu-composer__hint-start').text()).toBe('Shift+Tab change mode')
    await textarea().trigger('keydown', { key: 'Escape' })
    expect(pause).not.toHaveBeenCalled()
    input.blur()
    await flushPromises()
    expect(hint()).toBe('Esc pause')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', repeat: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', ctrlKey: true }))
    expect(pause).not.toHaveBeenCalled()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    await flushPromises()
    expect(pause).toHaveBeenCalledExactlyOnceWith(FIXTURE_SESSION_IDS.running)
    expect(input.value).toBe('Keep this draft')
    expect(hint()).toContain('↵ send')
  })

  it('lets Escape dismiss menus and ignores pause after the session screen unmounts', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    const pause = vi.spyOn(api, 'interruptSession')
    await wrapper!.find('[aria-label="Session settings and actions"]').trigger('click')
    const item = wrapper!.find('[role="menuitem"]')
    await item.trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(pause).not.toHaveBeenCalled()
    wrapper!.unmount()
    wrapper = undefined
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(pause).not.toHaveBeenCalled()
  })

  it('shows Send instead of Interrupt once something is typed while running, and queues it', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    const composer = () => wrapper!.find('.iu-composer')
    await textarea().setValue('Also check the docs')
    expect(composer().find('button[aria-label="Interrupt"]').exists()).toBe(false)
    const send = composer().find('button[aria-label="Send"]')
    expect(send.exists()).toBe(true)
    const interrupt = vi.spyOn(api, 'interruptSession')
    const sent = vi.spyOn(api, 'sendMessage')
    await send.trigger('click')
    await flushPromises()
    expect(sent).toHaveBeenCalledWith(
      FIXTURE_SESSION_IDS.running,
      expect.objectContaining({ text: 'Also check the docs' }),
    )
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('folds live frames into the thread', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    const id = FIXTURE_SESSION_IDS.running
    api.harnessEvent(id, {
      type: 'delta',
      entryId: 'live-1',
      kind: 'assistant',
      text: 'Streaming ',
      parentToolUseId: null,
    })
    api.harnessEvent(id, {
      type: 'delta',
      entryId: 'live-1',
      kind: 'assistant',
      text: 'words',
      parentToolUseId: null,
    })
    await flushPromises()
    expect(wrapper!.text()).toContain('Streaming words')
    expect(wrapper!.find('[aria-busy="true"]').exists()).toBe(true)
    api.harnessEvent(id, {
      type: 'entry',
      entry: {
        kind: 'assistant',
        id: 'live-1',
        text: 'Streaming words, done.',
        model: null,
        at: new Date().toISOString(),
        parentToolUseId: null,
      },
    })
    await flushPromises()
    expect(wrapper!.text()).toContain('Streaming words, done.')
  })

  it('sends "run tests", answers the prompt it raises and shows the streamed reply', async () => {
    const api = createMockApi({ replyDelayMs: 0 })
    await mountSession(FIXTURE_SESSION_IDS.idle, api)
    await textarea().setValue('run tests')
    await textarea().trigger('keydown', { key: 'Enter' })
    await vi.waitFor(() => expect(wrapper!.findComponent(IuPermissionPrompt).exists()).toBe(true))
    expect(textarea().attributes('disabled')).toBeDefined()
    wrapper!.findComponent(IuPermissionPrompt).vm.$emit('answer', {
      behavior: 'allow',
      scope: 'once',
    })
    await vi.waitFor(() => expect(wrapper!.text()).toContain('Mock reply to: "run tests"'), {
      timeout: 4000,
    })
    await vi.waitFor(() => expect(wrapper!.text()).toContain('Idle'), { timeout: 4000 })
    expect(wrapper!.find('.session-screen__announce').text()).toBe('The agent finished the turn')
  })

  it('has no artifact column when the session has no artifact', async () => {
    await mountSession(FIXTURE_SESSION_IDS.waiting)
    expect(wrapper!.find('aside[aria-label="Artifacts"]').exists()).toBe(false)
    expect(wrapper!.find('iframe').exists()).toBe(false)
    expect(wrapper!.find('[aria-label^="Show artifacts"]').exists()).toBe(false)
  })

  it('shows one artifact in the right column and a card in the thread', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.idle)
    const column = wrapper!.find('aside[aria-label="Artifacts"]')
    expect(column.exists()).toBe(true)
    expect(column.find('h2').text()).toBe('Pick a History layout')
    expect(column.find('[role="tablist"]').exists()).toBe(false)
    const iframe = column.find('iframe')
    expect(iframe.attributes('sandbox')).toBe('allow-scripts allow-forms')
    expect(iframe.attributes('src')).toBe(api.artifactUrl(1, 1))
    // the thread has a card instead of an inline frame
    const thread = wrapper!.find('[aria-label="Conversation"]')
    expect(thread.find('iframe').exists()).toBe(false)
    expect(thread.find('.artifact-card').text()).toContain('Pick a History layout')
    expect(thread.find('.artifact-card').text()).toContain('Showing')
  })

  it('lists artifacts in Details and previews a card without moving focus', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.ended)
    const column = wrapper!.find('aside[aria-label="Artifacts"]')
    expect(column.find('[role="tablist"]').exists()).toBe(false)
    await wrapper!.find('[aria-label="Show details"]').trigger('click')
    const links = wrapper!.findAll('.session-side__open').filter(b => b.text().includes(' · v'))
    expect(links.map(b => b.text())).toEqual([
      'Removal checklist · v2',
      'Module dependency map · v1',
    ])
    await links[0]!.trigger('click')
    await flushPromises()
    expect(column.find('iframe').attributes('src')).toBe(api.artifactUrl(2, 2))

    const cards = wrapper!.findAll('.artifact-card')
    expect(cards).toHaveLength(3)
    const first = cards[0]!.find('button')
    ;(first.element as HTMLButtonElement).focus()
    await first.trigger('click')
    await flushPromises()
    const shown = column
      .findAll('.artifact-panel__view')
      .find(v => v.attributes('style') === undefined)!
    expect(shown.find('iframe').attributes('src')).toBe(api.artifactUrl(2, 1))
    expect(cards[0]!.text()).toContain('Showing')
    // selecting from the thread leaves focus on the card
    expect(document.activeElement).toBe(first.element)
  })

  it('makes the artifact column a drawer on a narrow window', async () => {
    narrowScreen = true
    viewportWidth = 420
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewportWidth })
    await mountSession(FIXTURE_SESSION_IDS.idle)
    const aside = () => wrapper!.find('aside[aria-label="Artifacts"]')
    expect(wrapper!.find('[role="separator"][aria-label="Resize content preview"]').exists()).toBe(
      false,
    )
    expect(aside().attributes('role')).toBe('dialog')
    expect(aside().classes()).toContain('is-closed')
    const opener = wrapper!.find('[aria-label="Show artifacts (1)"]')
    ;(opener.element as HTMLButtonElement).focus()
    await opener.trigger('click')
    await flushPromises()
    expect(aside().classes()).not.toContain('is-closed')
    expect(opener.attributes('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(aside().find('[aria-label="Close panel"]').element)

    await aside().trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(aside().classes()).toContain('is-closed')
    expect(document.activeElement).toBe(opener.element)

    // a card opens the drawer on its artifact
    await wrapper!.find('.artifact-card button').trigger('click')
    await flushPromises()
    expect(aside().classes()).not.toContain('is-closed')
    await aside().find('[aria-label="Close panel"]').trigger('click')
    await flushPromises()
    expect(aside().classes()).toContain('is-closed')
  })

  it('shows an error page for an unknown session', async () => {
    await mountSession('nope')
    expect(wrapper!.text()).toContain('Session not found')
  })

  it('opens the fork modal from the header gear and navigates to the fork', async () => {
    const { api, router } = await mountSession(FIXTURE_SESSION_IDS.ended)
    await wrapper!.find('[aria-label="Session settings and actions"]').trigger('click')
    await flushPromises()
    await wrapper!
      .findAll('[role="menuitem"]')
      .find(b => b.text() === 'Fork…')!
      .trigger('click')
    await flushPromises()
    const modal = wrapper!.findComponent(ForkModal)
    expect(modal.props('open')).toBe(true)
    const dialog = document.querySelector('dialog')!
    const title = dialog.querySelector('input') as HTMLInputElement
    expect(title.value).toContain('(fork)')
    title.value = 'Try another way'
    title.dispatchEvent(new Event('input'))
    ;(dialog.querySelector('[role="switch"]') as HTMLButtonElement).click()
    await flushPromises()
    ;[...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Fork')!.click()
    await flushPromises()
    const fork = api.db.sessions.find(s => s.title === 'Try another way')
    expect(fork?.parentId).toBe(FIXTURE_SESSION_IDS.ended)
    await flushPromises()
    expect(router.currentRoute.value.path).toBe(`/s/${fork!.id}`)
  })
})

describe('ForkModal', () => {
  it('sends the title, worktree choice and first message', async () => {
    const api = createMockApi()
    const spy = vi.spyOn(api, 'forkSession')
    wrapper = mount(ForkModal, {
      props: {
        sessionId: FIXTURE_SESSION_IDS.ended,
        title: 'Cleanup',
        inWorktree: false,
        open: true,
      },
      attachTo: document.body,
      global: { provide: { [API_KEY as symbol]: api } },
    })
    await flushPromises()
    const dialog = document.querySelector('dialog')!
    expect((dialog.querySelector('input') as HTMLInputElement).value).toBe('Cleanup (fork)')
    ;(dialog.querySelector('[role="switch"]') as HTMLButtonElement).click()
    const area = dialog.querySelector('textarea') as HTMLTextAreaElement
    area.value = 'Keep the runner this time'
    area.dispatchEvent(new Event('input'))
    await flushPromises()
    ;[...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Fork')!.click()
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.ended, {
      title: 'Cleanup (fork)',
      worktree: true,
      prompt: { text: 'Keep the runner this time' },
    })
    expect(wrapper.emitted('forked')).toHaveLength(1)
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
  })

  it('shows the error and stays open when the fork fails', async () => {
    const api = createMockApi()
    vi.spyOn(api, 'forkSession').mockRejectedValue(new Error('worktree refused'))
    wrapper = mount(ForkModal, {
      props: { sessionId: 'x', title: 'T', inWorktree: false, open: true },
      attachTo: document.body,
      global: { provide: { [API_KEY as symbol]: api } },
    })
    await flushPromises()
    const dialog = document.querySelector('dialog')!
    ;[...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Fork')!.click()
    await flushPromises()
    expect(dialog.textContent).toContain('worktree refused')
    expect(wrapper.emitted('forked')).toBeUndefined()
  })
})

describe('SessionScreen drafts and side threads', () => {
  const value = () => (textarea().element as HTMLTextAreaElement).value

  it('keeps each session’s draft across switching and clears it once sent', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.idle)
    await textarea().setValue('Half a thought')
    await wrapper!.setProps({ id: FIXTURE_SESSION_IDS.ended })
    await flushPromises()
    expect(value()).toBe('')
    await textarea().setValue('Another draft')
    await wrapper!.setProps({ id: FIXTURE_SESSION_IDS.idle })
    await flushPromises()
    expect(value()).toBe('Half a thought')
    // restoring never takes focus
    expect(document.activeElement).not.toBe(textarea().element)
    expect(localStorage.getItem(`odin:draft:${FIXTURE_SESSION_IDS.idle}`)).toBe('Half a thought')

    const send = vi.spyOn(api, 'sendMessage')
    await textarea().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(send).toHaveBeenCalledWith(
      FIXTURE_SESSION_IDS.idle,
      expect.objectContaining({ text: 'Half a thought', clientId: expect.any(String) }),
    )
    expect(localStorage.getItem(`odin:draft:${FIXTURE_SESSION_IDS.idle}`)).toBeNull()
    expect(localStorage.getItem(`odin:draft:${FIXTURE_SESSION_IDS.ended}`)).toBe('Another draft')
  })

  it('asks ⌥↵ on the side: forks aside, opens the Side view, keeps focus in the box', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.idle)
    const fork = vi.spyOn(api, 'forkSession')
    const send = vi.spyOn(api, 'sendMessage')
    ;(textarea().element as HTMLTextAreaElement).focus()
    await textarea().setValue('Why is the list slow?')
    await textarea().trigger('keydown', { key: 'Enter', altKey: true })
    await flushPromises()
    expect(fork).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.idle, {
      aside: true,
      prompt: { text: 'Why is the list slow?' },
    })
    expect(send).not.toHaveBeenCalled()
    expect(value()).toBe('')
    expect(document.activeElement).toBe(textarea().element)
    const pane = wrapper!.find('.session-workbench[data-tab="side"] .side-pane')
    expect(pane.exists()).toBe(true)
    expect(pane.find('.side-pane__item[aria-current="true"]').text()).toContain(
      'Side: Why is the list slow?',
    )
    await vi.waitFor(() =>
      expect(pane.find('.side-thread').text()).toContain('Why is the list slow?'),
    )
    expect(wrapper!.find('button[aria-label="Side threads (1)"]').exists()).toBe(true)
  })

  it('asks on the side with /btw and ⌥/ while keeping the toolbar compact', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    const fork = vi.spyOn(api, 'forkSession')
    await textarea().setValue('/btw what does compact do?')
    await textarea().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(fork).toHaveBeenLastCalledWith(FIXTURE_SESSION_IDS.running, {
      aside: true,
      prompt: { text: 'what does compact do?' },
    })

    expect(
      wrapper!.findAll('.session-composer button').some(b => b.text() === 'Side question'),
    ).toBe(false)
    expect(useCommands().value.map(c => c.id)).toContain('session-side-question')
    const stop = installShortcuts()
    textarea().element.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Slash', key: '÷', altKey: true, bubbles: true }),
    )
    stop()
    await flushPromises()
    expect(textarea().attributes('placeholder')).toContain('Ask a side question')
    expect(document.activeElement).toBe(textarea().element)
    await textarea().setValue('and plan mode?')
    await textarea().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(fork).toHaveBeenLastCalledWith(FIXTURE_SESSION_IDS.running, {
      aside: true,
      prompt: { text: 'and plan mode?' },
    })
    expect(textarea().attributes('placeholder')).toContain('Queue a message')
  })

  it('gives the question back when the side fork fails', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.idle)
    api.forkSession = () => Promise.reject(new Error('nope'))
    await textarea().setValue('Kept?')
    await textarea().trigger('keydown', { key: 'Enter', altKey: true })
    await flushPromises()
    expect(value()).toBe('Kept?')
    expect(wrapper!.find('.side-pane').exists()).toBe(false)
  })

  it('inserts the side reply into the message, and discards after a confirm', async () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '')
    }
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    await textarea().setValue('My note')
    await wrapper!.find('button[aria-label="Side threads (1)"]').trigger('click')
    await flushPromises()
    const pane = () => wrapper!.find('.side-pane')
    expect(pane().text()).toContain('Side: Does the thread keep scroll position')
    // only the side conversation, not the parent's copy
    expect(pane().find('.side-thread').text()).toContain('Jump to latest')
    expect(pane().find('.side-thread').text()).not.toContain('Also show context usage')

    await pane()
      .findAll('button')
      .find(b => b.text() === 'Insert into message')!
      .trigger('click')
    await flushPromises()
    expect(value()).toMatch(/^My note\n\n> Yes\. SessionThread only follows the bottom/)

    const remove = vi.spyOn(api, 'deleteSession')
    await pane()
      .findAll('button')
      .find(b => b.text() === 'Discard…')!
      .trigger('click')
    await flushPromises()
    const confirm = wrapper!.findAll('dialog button').find(b => b.text() === 'Discard')!
    ;(confirm.element as HTMLButtonElement).focus()
    await confirm.trigger('click')
    await flushPromises()
    expect(remove).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.aside)
    expect(pane().text()).toContain('No side threads')
    expect(document.activeElement?.classList.contains('side-pane__heading')).toBe(true)
  })

  it('sends follow-ups to the side thread from its own draft', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    await textarea().setValue('Main draft')
    await wrapper!.find('button[aria-label="Side threads (1)"]').trigger('click')
    await flushPromises()
    const follow = () => wrapper!.find('.side-thread textarea')
    await follow().setValue('And when scrolled?')
    expect(localStorage.getItem(`odin:draft:${FIXTURE_SESSION_IDS.aside}`)).toBe(
      'And when scrolled?',
    )
    expect(value()).toBe('Main draft')
    const send = vi.spyOn(api, 'sendMessage')
    await follow().trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(send).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.aside, { text: 'And when scrolled?' })
    expect(localStorage.getItem(`odin:draft:${FIXTURE_SESSION_IDS.aside}`)).toBeNull()
    expect(value()).toBe('Main draft')
    await vi.waitFor(() =>
      expect(wrapper!.find('.side-thread').text()).toContain('And when scrolled?'),
    )
  })

  it('promotes a side thread out of the Side view', async () => {
    const { api } = await mountSession(FIXTURE_SESSION_IDS.running)
    const update = vi.spyOn(api, 'updateSession')
    await wrapper!.find('button[aria-label="Side threads (1)"]').trigger('click')
    await flushPromises()
    await wrapper!
      .findAll('.side-pane button')
      .find(b => b.text() === 'Promote')!
      .trigger('click')
    await flushPromises()
    expect(update).toHaveBeenCalledWith(FIXTURE_SESSION_IDS.aside, { aside: false })
    expect(wrapper!.find('.side-pane').text()).toContain('No side threads')
    expect((await api.listSessions()).some(s => s.id === FIXTURE_SESSION_IDS.aside)).toBe(true)
  })

  it('leaves the pane closed on a narrow window when a side question is asked', async () => {
    narrowScreen = true
    await mountSession(FIXTURE_SESSION_IDS.idle)
    ;(textarea().element as HTMLTextAreaElement).focus()
    await textarea().setValue('Quick one')
    await textarea().trigger('keydown', { key: 'Enter', altKey: true })
    await flushPromises()
    expect(wrapper!.find('.side-pane').exists()).toBe(false)
    expect(document.activeElement).toBe(textarea().element)
    expect(wrapper!.find('button[aria-label="Side threads (1)"]').exists()).toBe(true)
  })
})
