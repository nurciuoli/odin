import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import ComposerChoice from './ComposerChoice.vue'
import ComposerProjects from './ComposerProjects.vue'
import { IuComposer } from '@/components/Composer'
import { useToast } from '@/components/Toast'
import NewSessionForm from './NewSessionForm.vue'
import { lastRuntime, rememberRuntime } from './lastRuntime'
import { mountScreen } from './testSupport'
import { resetDrafts, useDrafts } from '@/app/drafts'
import { dispatchShortcut } from '@/app/shortcuts'

async function mountForm(props: Record<string, unknown> = {}, api = createMockApi()) {
  const ctx = await mountScreen(NewSessionForm, '/', api, props)
  await flushPromises()
  const modeChip = () => ctx.wrapper.find('button[aria-label^="Permission mode:"]')
  const pick = async (label: string, value: string) => {
    if (label === 'Permission mode') {
      // the mode chip cycles; click until it names the wanted mode
      for (let i = 0; i < 8 && modeChip().attributes('data-mode') !== value; i++)
        await modeChip().trigger('click')
      expect(modeChip().attributes('data-mode')).toBe(value)
    } else if (label === 'Project') {
      ctx.wrapper.findComponent(ComposerProjects).vm.$emit('update:modelValue', value)
      ctx.wrapper.findComponent(ComposerProjects).vm.$emit('update:projects', [value])
    } else
      ctx.wrapper
        .findAllComponents(ComposerChoice)
        .find(c => c.props('label') === label)!
        .vm.$emit('update:modelValue', value)
    await flushPromises()
  }
  const start = () => ctx.wrapper.find('button[aria-label="Send"]')
  const type = async (text: string) => ctx.wrapper.find('textarea').setValue(text)
  return { ...ctx, pick, start, type, modeChip }
}

describe('NewSessionForm', () => {
  it('sends the selected effort at launch and clears it for an unsupported model', async () => {
    const api = createMockApi()
    api.listModels = async () => [
      {
        value: 'default',
        displayName: 'Default',
        description: '',
        resolved: null,
        effortLevels: ['low', 'high'],
      },
      { value: 'fast', displayName: 'Fast', description: '', resolved: null },
    ]
    const { wrapper, type, start } = await mountForm({ project: 'odin' }, api)
    wrapper.findComponent(IuComposer).vm.$emit('update:modelId', 'default')
    await flushPromises()
    wrapper.findComponent(IuComposer).vm.$emit('update:effort', 'high')
    await flushPromises()
    expect(wrapper.findComponent(IuComposer).props('effort')).toBe('high')
    await type('Go')
    const spy = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }))
    wrapper.findComponent(IuComposer).vm.$emit('update:modelId', 'fast')
    await flushPromises()
    expect(wrapper.findComponent(IuComposer).props('effort')).toBeNull()
    expect(wrapper.findAllComponents(ComposerChoice).some(c => c.props('label') === 'Effort')).toBe(
      false,
    )
  })

  beforeEach(() => {
    localStorage.removeItem('odin:last-runtime')
    localStorage.removeItem('odin:draft:new')
    resetDrafts()
  })
  it('restores the last used runtime and its model after remounting', async () => {
    rememberRuntime('codex', { model: 'remembered-codex-model' })
    try {
      const ctx = await mountForm()
      expect(ctx.wrapper.findComponent(IuComposer).props('modelId')).toBe('remembered-codex-model')
      expect(
        ctx.wrapper
          .findAllComponents(ComposerChoice)
          .find(c => c.props('label') === 'Harness')
          ?.props('modelValue'),
      ).toBe('codex')
      ctx.wrapper.unmount()
    } finally {
      localStorage.removeItem('odin:last-runtime')
    }
  })
  it('starts in the last used permission mode and remembers the one a session starts with', async () => {
    rememberRuntime('claude', { permissionMode: 'plan' })
    const { api, modeChip, type, start, pick } = await mountForm({ project: 'odin' })
    expect(modeChip().attributes('data-mode')).toBe('plan')
    await pick('Permission mode', 'auto')
    await type('Go')
    const started = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'auto' }))
    expect(lastRuntime().modes.claude).toBe('auto')
  })
  it('never carries bypass permissions over to a new session', async () => {
    rememberRuntime('claude', { permissionMode: 'acceptEdits' })
    rememberRuntime('claude', { permissionMode: 'bypassPermissions' })
    expect(lastRuntime().modes.claude).toBe('acceptEdits')
    const { modeChip } = await mountForm({ project: 'odin' })
    expect(modeChip().attributes('data-mode')).toBe('acceptEdits')
  })
  it('ignores a remembered mode the harness does not support', async () => {
    rememberRuntime('codex', { permissionMode: 'auto' })
    const { modeChip } = await mountForm({ project: 'odin' })
    expect(modeChip().attributes('data-mode')).toBe('default')
  })
  it('replaces a saved WSL launch default with native Codex', async () => {
    const api = createMockApi()
    await api.updateSettings({ settings: { defaultHarness: 'codex-wsl' } })
    const models = vi.spyOn(api, 'listModels')
    const started = vi.spyOn(api, 'startSession')
    const { wrapper, type, start } = await mountForm({ project: 'odin' }, api)
    const harness = wrapper
      .findAllComponents(ComposerChoice)
      .find(c => c.props('label') === 'Harness')!
    expect(harness.props('modelValue')).toBe('codex')
    expect(JSON.stringify(harness.props('options'))).not.toContain('codex-wsl')
    expect(models).toHaveBeenCalledWith('codex')
    await type('Review this project')
    await start().trigger('click')
    await flushPromises()
    expect(started).toHaveBeenCalledWith(expect.objectContaining({ harness: 'codex' }))
  })
  it('configures multiple repositories and lets the user choose the working repository', async () => {
    const { wrapper, api, type, start } = await mountForm()
    await wrapper.find('button[aria-label^="Projects:"]').trigger('click')
    const rick = wrapper.findAll('[role="menuitemcheckbox"]').find(b => b.text().includes('Rick'))!
    await rick.trigger('click')
    expect(wrapper.find('button[aria-label^="Projects:"]').text()).toContain('+1')
    await wrapper
      .findAll('[role="menuitem"]')
      .find(b => b.text().includes('Working repository'))!
      .trigger('click')
    await wrapper
      .findAll('[role="menuitemradio"]')
      .find(b => b.text().includes('Rick'))!
      .trigger('click')
    await type('Update both repositories')
    const spy = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'rick', projects: ['rick', 'odin'] }),
    )
    const found = await api.listSessions({ project: 'odin', q: 'Update both repositories' })
    expect(found[0]!.projects).toEqual(['rick', 'odin'])
  })
  it('offers project and harness configuration with no workflow or primary-agent choice', async () => {
    const { wrapper, api, pick, type, start } = await mountForm()
    const library = vi.spyOn(api, 'listLibrary')
    const labels = wrapper.findAllComponents(ComposerChoice).map(c => c.props('label'))
    expect(labels).toEqual(['Harness'])
    expect(wrapper.findComponent(ComposerProjects).exists()).toBe(true)
    const controls = wrapper.find('.new-session__launch-controls').element
    expect(controls.contains(wrapper.findComponent(ComposerChoice).element)).toBe(true)
    expect(
      controls.compareDocumentPosition(wrapper.find('textarea').element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(wrapper.findComponent(IuComposer).element.contains(controls)).toBe(false)
    await pick('Project', 'odin')
    await type('Review this code')
    expect(wrapper.find('button[aria-label="Send"]').exists()).toBe(true)
    expect(wrapper.findAll('button').some(b => b.text() === 'Start session')).toBe(false)
    const started = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(started.mock.calls[0]![0]).not.toHaveProperty('agent')
    expect(started.mock.calls[0]![0]).not.toHaveProperty('templateId')
    expect(library).not.toHaveBeenCalled()
  })
  it('changes the model catalog and permission choices when selecting Codex', async () => {
    const { api, wrapper, pick, start, type, modeChip } = await mountForm({ project: 'odin' })
    const models = vi.spyOn(api, 'listModels')
    await pick('Harness', 'codex')
    await flushPromises()
    expect(models).toHaveBeenCalledWith('codex')
    expect(wrapper.findComponent(IuComposer).props('models')).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'codex-test' })]),
    )
    const seen: string[] = []
    do {
      seen.push(modeChip().text())
      await modeChip().trigger('click')
    } while (modeChip().text() !== seen[0] && seen.length < 10)
    expect(seen[0]).toBe('Ask before edits')
    expect(seen).not.toContain('Auto')
    expect(seen.length).toBeLessThan(6)
    await type('Inspect this project')
    const started = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'codex', permissionMode: 'default' }),
    )
    const sessions = await api.listSessions({ project: 'odin', q: 'Inspect this project' })
    expect(sessions[0]!.harness).toBe('codex')
  })
  it('preselects a project and prevents sending an empty message', async () => {
    const { api, wrapper, start } = await mountForm()
    const spy = vi.spyOn(api, 'startSession')
    expect(wrapper.findComponent(ComposerProjects).props('modelValue')).toBe('odin')
    expect(start().attributes('disabled')).toBeDefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps a new conversation as a draft until its first message is sent', async () => {
    const api = createMockApi()
    const started = vi.spyOn(api, 'startSession')
    const before = await api.listSessions()
    const ctx = await mountForm({}, api)
    await ctx.type('An unfinished thought')
    await ctx.pick('Harness', 'codex')
    ctx.wrapper.unmount()
    expect(started).not.toHaveBeenCalled()
    expect(await api.listSessions()).toEqual(before)
    const reopened = await mountForm({}, api)
    expect((reopened.wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(
      'An unfinished thought',
    )
    expect(started).not.toHaveBeenCalled()
    await reopened.start().trigger('click')
    await flushPromises()
    expect(started).toHaveBeenCalledTimes(1)
    expect(started).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: { text: 'An unfinished thought' } }),
    )
    reopened.wrapper.unmount()
  })

  it('uses configured runtime, model, permissions and worktree defaults', async () => {
    const api = createMockApi()
    await api.updateSettings({
      settings: {
        defaultHarness: 'codex',
        harnessDefaults: { codex: { model: 'codex-test', permissionMode: 'plan' } },
        defaultWorktree: true,
      },
    })
    const { wrapper, start, type } = await mountForm({}, api)
    expect(wrapper.findComponent(IuComposer).props('modelId')).toBe('codex-test')
    expect(wrapper.find('textarea').attributes('placeholder')).toBe('Message Codex…')
    await type('Inspect the project')
    const spy = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        project: 'odin',
        harness: 'codex',
        model: 'codex-test',
        permissionMode: 'plan',
        where: { kind: 'new-worktree' },
      }),
    )
  })

  it('sends chat attachments with the first message and preserves them after an error', async () => {
    const { api, wrapper, type, start } = await mountForm()
    wrapper
      .findComponent(IuComposer)
      .vm.$emit('attach', [new File(['Project details'], 'notes.txt', { type: 'text/plain' })])
    await flushPromises()
    await type('Read these notes')
    const spy = vi.spyOn(api, 'startSession').mockRejectedValue(new Error('Try again'))
    await start().trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: {
          text: 'Read these notes',
          attachments: [{ name: 'notes.txt', mediaType: 'text/plain', data: 'Project details' }],
        },
      }),
    )
    expect(wrapper.find('textarea').element.value).toBe('Read these notes')
    expect(wrapper.text()).toContain('notes.txt')
  })

  it('starts a session with the typed prompt and goes to it', async () => {
    const { api, router, pick, start, type } = await mountForm()
    await pick('Project', 'odin')
    await type('Why is history search slow?')
    await start().trigger('click')
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('session'), {
      timeout: 5000,
    })
    const [first] = await api.listSessions({ project: 'odin', q: 'history search slow' })
    expect(first!.id).toBe(router.currentRoute.value.params.id)
  })

  it('keeps the prompt and shows the server error when starting fails', async () => {
    const { api, wrapper, pick, start, type } = await mountForm({ project: 'odin' })
    api.startSession = () => Promise.reject(new Error('worktree failed'))
    await pick('Permission mode', 'plan')
    await type('Try it')
    await start().trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('worktree failed')
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('Try it')
  })

  it('cycles the permission mode from the chip, wrapping around, without a dropdown', async () => {
    const { wrapper, modeChip } = await mountForm({ project: 'odin' })
    expect(wrapper.find('[role="combobox"]:not(textarea), [role="listbox"]').exists()).toBe(false)
    const chip = modeChip()
    expect(chip.element.tagName).toBe('BUTTON')
    expect(chip.attributes('aria-label')).toBe(
      'Permission mode: Ask before edits. Activate to change',
    )
    const order: string[] = []
    for (let i = 0; i < 6; i++) {
      await modeChip().trigger('click')
      order.push(modeChip().text())
    }
    expect(order).toEqual([
      'Accept edits',
      'Plan only',
      'Auto',
      "Don't ask",
      'Bypass permissions',
      'Ask before edits',
    ])
    const live = wrapper.find('[aria-live="polite"].sr-only')
    expect(live.text()).toBe('Permission mode: Ask before edits')
    expect(wrapper.find('button[aria-label^="Where it runs:"]').text()).toContain('⎇ main')
  })

  it('opens the where popover from the chip, never on its own, and sends a typed branch', async () => {
    const { wrapper, api, type, start } = await mountForm({ project: 'odin' })
    expect(wrapper.find('.composer-where__pop').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Configure')
    const chip = () => wrapper.find('button[aria-label^="Where it runs:"]')
    await chip().trigger('click')
    await wrapper.find('[data-where="new-worktree"]').trigger('click')
    expect(chip().text()).toContain('New worktree · auto')
    await wrapper.find('input[data-name]').setValue('feat/x')
    expect(chip().text()).toContain('New worktree · feat/x')
    await type('Go')
    const spy = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: 'new-worktree', branch: 'feat/x' } }),
    )
    // nothing is remembered: back to the default after the send
    expect(chip().text()).toContain('⎇ main')
  })

  it('reopens the popover when the branch is invalid on send', async () => {
    const { wrapper, api, type, start } = await mountForm({ project: 'odin' })
    const chip = () => wrapper.find('button[aria-label^="Where it runs:"]')
    await chip().trigger('click')
    await wrapper.find('[data-where="new-worktree"]').trigger('click')
    await wrapper.find('input[data-name]').setValue('bad..name')
    await chip().trigger('click')
    expect(wrapper.find('.composer-where__pop').exists()).toBe(false)
    await type('Go')
    const spy = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    expect(wrapper.find('.composer-where__pop').exists()).toBe(true)
    expect(wrapper.find('.composer-where__message[role="status"]').text()).toContain(
      'valid Git branch',
    )
  })

  it('toggles checkout and worktree with Alt+W', async () => {
    const { wrapper } = await mountForm({ project: 'odin' })
    const chip = () => wrapper.find('button[aria-label^="Where it runs:"]')
    expect(chip().text()).toContain('⎇ main')
    dispatchShortcut(new KeyboardEvent('keydown', { key: 'w', altKey: true, cancelable: true }))
    await flushPromises()
    expect(chip().text()).toContain('New worktree')
    wrapper.unmount()
  })

  it('cycles the permission mode with Shift+Tab in the message box and keeps focus there', async () => {
    const { wrapper, api, type, start, modeChip } = await mountForm({ project: 'odin' })
    const textarea = wrapper.find('textarea')
    ;(textarea.element as HTMLTextAreaElement).focus()
    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true })
    textarea.element.dispatchEvent(event)
    await flushPromises()
    expect(event.defaultPrevented).toBe(true)
    expect(modeChip().text()).toBe('Accept edits')
    expect(wrapper.find('[aria-live="polite"].sr-only').text()).toBe(
      'Permission mode: Accept edits',
    )
    // plain Tab still moves focus normally
    const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true })
    textarea.element.dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    await type('Go')
    const spy = vi.spyOn(api, 'startSession')
    await start().trigger('click')
    await flushPromises()
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'acceptEdits' }))
  })

  it('puts the mode hint on the left and the send hints on the right', async () => {
    const { wrapper } = await mountForm({ project: 'odin' })
    const hint = wrapper.find('.iu-composer__hint')
    const [left, right] = hint.element.children
    expect(left!.textContent).toBe('⇧⇥ change mode')
    expect(right!.textContent).toBe('↵ send · Ctrl+↵ in background · ⇧↵ newline')
  })

  it('starts in the background on Ctrl+Enter: stays put, clears the draft, toasts with Open', async () => {
    const { wrapper, router, api, type } = await mountForm({ project: 'odin' })
    const started = vi.spyOn(api, 'startSession')
    await type('Look into the flaky test')
    expect(useDrafts().get('new').text).toBe('Look into the flaky test')
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
    expect(started).toHaveBeenCalledTimes(1)
    expect(router.currentRoute.value.name).toBe('home')
    expect(wrapper.emitted('started')?.[0]?.[1]).toBe(true)
    expect(useDrafts().get('new').text).toBe('')
    const toast = useToast().items.value.find(t => t.title === 'Started Look into the flaky test')
    expect(toast?.action?.label).toBe('Open')
    toast!.action!.onClick()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('session'))
    wrapper.unmount()
  })

  it('in the quick launch mode, Enter starts in the background and Ctrl+Enter opens', async () => {
    const { wrapper, router, type } = await mountForm({
      project: 'odin',
      backgroundDefault: true,
    })
    expect(wrapper.find('.iu-composer__hint').text()).toContain('↵ start in background')
    await type('First')
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(router.currentRoute.value.name).toBe('home')
    await type('Second')
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter', metaKey: true })
    await flushPromises()
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('session'))
    expect(wrapper.emitted('started')?.map(e => e[1])).toEqual([true, false])
    wrapper.unmount()
  })

  it('keeps the draft across remounts under the "new" key', async () => {
    const first = await mountForm({ project: 'odin' })
    await first.type('Half a thought')
    await flushPromises()
    first.wrapper.unmount()
    const second = await mountForm({ project: 'odin' })
    expect((second.wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe(
      'Half a thought',
    )
    second.wrapper.unmount()
  })
})
