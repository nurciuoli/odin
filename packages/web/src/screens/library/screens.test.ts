import { beforeAll, describe, expect, it, vi } from 'vitest'
import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { IuDiff } from '@/components/CodeBlock'
import SelectField from '@/screens/shared/SelectField.vue'
import { mountScreen } from '@/screens/shared/testSupport'
import AssetScreen from './AssetScreen.vue'
import InstallModal from './InstallModal.vue'
import ImportPluginModal from './ImportPluginModal.vue'
import LibraryScreen from './LibraryScreen.vue'
import SaveToLibraryModal from './SaveToLibraryModal.vue'
import type { SessionSource } from './assetForm'

beforeAll(() => {
  // jsdom has no <dialog> modal API; the library Dialog calls these when it opens
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute('open')
  }
})

const button = (w: VueWrapper, label: string) => w.findAll('button').find(b => b.text() === label)

describe('LibraryScreen', () => {
  it('opens global instructions without overwriting existing content', async () => {
    const api = createMockApi()
    const save = vi.spyOn(api, 'saveAsset')
    const { wrapper, router } = await mountScreen(LibraryScreen, '/library', api)
    await flushPromises()
    await button(wrapper, 'Global instructions')!.trigger('click')
    await flushPromises()
    expect(save).not.toHaveBeenCalled()
    expect(router.currentRoute.value.fullPath).toBe('/library/instruction/global')
  })

  it('lists a kind per tab with where it is used and an install action', async () => {
    const { wrapper } = await mountScreen(LibraryScreen, '/library?kind=agent')
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('reviewer')
    expect(text).toContain('docs-writer')
    expect(wrapper.find('thead').text()).toContain('Used in')
    expect(wrapper.find('button[aria-label^="More actions for"]').exists()).toBe(true)
    expect(wrapper.find('thead').text()).toContain('Enabled')
    expect(wrapper.find('thead').text()).not.toContain('Version')
    expect(
      wrapper
        .findAll('[role=tab]')
        .map(t => t.text())
        .join(' '),
    ).toContain('MCP servers')
    expect(button(wrapper, 'New agent')).toBeTruthy()
  })

  it('switches an item off and on from its row', async () => {
    const api = createMockApi()
    const set = vi.spyOn(api, 'setAssetEnabled')
    const { wrapper } = await mountScreen(LibraryScreen, '/library?kind=agent', api)
    await flushPromises()
    await wrapper.find('[role=switch]').trigger('click')
    await flushPromises()
    expect(set).toHaveBeenCalledWith('agent', expect.any(String), false)
    expect(wrapper.text()).toContain('Disabled')
    expect((await api.listLibrary('agent')).some(a => !a.enabled)).toBe(true)
  })

  it('deletes selected items after a confirmation that offers Disable instead', async () => {
    const api = createMockApi()
    const before = (await api.listLibrary('agent')).length
    const { wrapper } = await mountScreen(LibraryScreen, '/library?kind=agent', api)
    await flushPromises()
    expect(wrapper.find('[role=toolbar]').exists()).toBe(false)
    await wrapper.find('tbody input[type=checkbox]').setValue(true)
    expect(wrapper.find('[role=toolbar]').text()).toContain('1 selected')
    await button(wrapper, 'Delete…')!.trigger('click')
    await flushPromises()
    expect(button(wrapper, 'Disable instead')).toBeTruthy()
    await button(wrapper, 'Delete')!.trigger('click')
    await flushPromises()
    expect((await api.listLibrary('agent')).length).toBe(before - 1)
  })

  it('shows MCP servers as a tab with their sign-in state', async () => {
    const { wrapper } = await mountScreen(LibraryScreen, '/library?kind=mcp')
    await flushPromises()
    expect(wrapper.find('thead').text()).toContain('Sign-in')
    expect(wrapper.text()).toContain('Secrets')
  })

  it('puts instructions, skills and subagents in the library without launch workflows', async () => {
    const { wrapper } = await mountScreen(LibraryScreen, '/library')
    await flushPromises()
    const tabs = wrapper
      .findAll('[role=tab]')
      .map(t => t.text())
      .join(' ')
    expect(tabs).toContain('AGENTS.md')
    expect(tabs).toContain('Skills')
    expect(tabs).not.toMatch(/Prompts|Templates|Commands/)
    expect(wrapper.text()).toContain('Global AGENTS.md')
  })

  it('creates a new asset from the modal and opens it', async () => {
    const api = createMockApi()
    const { wrapper, router } = await mountScreen(LibraryScreen, '/library?kind=skill', api)
    await flushPromises()
    const inputs = wrapper.findAll('dialog input')
    await inputs[0]!.setValue('Triage the inbox')
    expect((inputs[1]!.element as HTMLInputElement).value).toBe('triage-the-inbox')
    await button(wrapper, 'Create')!.trigger('click')
    await flushPromises()
    expect((await api.getAsset('skill', 'triage-the-inbox')).files['SKILL.md']).toContain(
      'name: triage-the-inbox',
    )
    expect(router.currentRoute.value.fullPath).toBe('/library/skill/triage-the-inbox')
  })
})

describe('AssetScreen', () => {
  it('refreshes a clean editor after an external library update', async () => {
    const api = createMockApi()
    const { wrapper } = await mountScreen(AssetScreen, '/library/agent/reviewer', api, {
      kind: 'agent',
      id: 'reviewer',
    })
    await flushPromises()
    const before = await api.getAsset('agent', 'reviewer')
    const file = Object.keys(before.files)[0]!
    await api.saveAsset('agent', 'reviewer', {
      ...before.files,
      [file]: before.files[file] + '\nExternal update.',
    })
    await flushPromises()
    expect(
      wrapper
        .findAll('textarea')
        .some(t => (t.element as HTMLTextAreaElement).value.includes('External update.')),
    ).toBe(true)
    expect(button(wrapper, 'Save as new version')!.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
  it('saves an edit as a new version', async () => {
    const api = createMockApi()
    const before = await api.getAsset('agent', 'reviewer')
    const { wrapper } = await mountScreen(AssetScreen, '/library/agent/reviewer', api, {
      kind: 'agent',
      id: 'reviewer',
    })
    await flushPromises()
    const save = () => wrapper.findAll('button').find(b => b.text() === 'Save as new version')!
    expect(save().attributes('disabled')).toBeDefined()
    const body = wrapper.findAll('textarea')[0]!
    await body.setValue('You review changes. Be brief.')
    expect(save().attributes('disabled')).toBeUndefined()
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const after = await api.getAsset('agent', 'reviewer')
    expect(after.versions.length).toBe(before.versions.length + 1)
    expect(after.asset.version).not.toBe(before.asset.version)
    expect(after.files['reviewer.md']).toContain('Be brief.')
    expect(after.files['reviewer.md']).toContain('name: reviewer')
  })

  it('diffs two versions', async () => {
    const { wrapper } = await mountScreen(AssetScreen, '/library/agent/reviewer', createMockApi(), {
      kind: 'agent',
      id: 'reviewer',
    })
    await flushPromises()
    await wrapper
      .findAll('[role=tab]')
      .find(t => t.text().startsWith('Versions'))!
      .trigger('click')
    await flushPromises()
    const diff = wrapper.findComponent(IuDiff)
    expect(diff.exists()).toBe(true)
    expect(diff.text()).toContain('reviewer.md')
    const pickers = wrapper.findAllComponents(SelectField)
    pickers[0]!.vm.$emit('update:modelValue', pickers[1]!.props('options')[0].id)
    await flushPromises()
    expect(wrapper.text()).toContain('identical')
  })

  it('shows installs with their drift state', async () => {
    const { wrapper } = await mountScreen(AssetScreen, '/library/agent/reviewer', createMockApi(), {
      kind: 'agent',
      id: 'reviewer',
    })
    await flushPromises()
    await wrapper
      .findAll('[role=tab]')
      .find(t => t.text().startsWith('Installs'))!
      .trigger('click')
    expect(wrapper.text()).toContain('Update available')
    expect(button(wrapper, 'Update')).toBeTruthy()
  })

  it('links back to the MCP list and opens sign-in when a remote server needs it', async () => {
    const api = createMockApi()
    const start = vi.spyOn(api, 'startMcpOAuth')
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const { wrapper } = await mountScreen(AssetScreen, '/library/mcp/internal', api, {
      kind: 'mcp',
      id: 'internal',
    })
    await flushPromises()
    const back = wrapper.find('.asset__back')
    expect(back.text()).toBe('MCP servers')
    expect(back.attributes('href')).toBe('/library?kind=mcp')
    expect(wrapper.text()).not.toContain('Form')
    const desc = wrapper
      .findAll('input')
      .find(i => (i.element as HTMLInputElement).value.includes('API key'))!
    await desc.setValue('Internal service')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    const saved = JSON.parse((await api.getAsset('mcp', 'internal')).files['internal.json']!)
    expect(saved.oauth).toEqual({})
    expect(start).toHaveBeenCalledWith('internal', window.location.origin)
    expect(open).toHaveBeenCalled()
    wrapper.unmount()
    vi.unstubAllGlobals()
  })

  it('updates an install from the Installs tab', async () => {
    const api = createMockApi()
    const { wrapper } = await mountScreen(AssetScreen, '/library/agent/reviewer', api, {
      kind: 'agent',
      id: 'reviewer',
    })
    await flushPromises()
    await button(wrapper, 'Update')!.trigger('click')
    await flushPromises()
    const installs = await api.listInstallations('odin')
    expect(installs.find(i => i.id === 'reviewer')!.state).toBe('current')
  })

  it('does not expose legacy templates as a launchable asset', async () => {
    const { wrapper } = await mountScreen(
      AssetScreen,
      '/library/template/quick-review',
      createMockApi(),
      { kind: 'template', id: 'quick-review' },
    )
    await flushPromises()
    expect(wrapper.text()).toContain('Unknown kind')
    expect(button(wrapper, 'Start a session')).toBeUndefined()
  })

  it('says so for a missing asset', async () => {
    const { wrapper } = await mountScreen(AssetScreen, '/library/agent/nope', createMockApi(), {
      kind: 'agent',
      id: 'nope',
    })
    await flushPromises()
    expect(wrapper.text()).toContain('Not in the library')
  })
})

describe('InstallModal', () => {
  it('installs an asset into the chosen project', async () => {
    const api = createMockApi()
    const { wrapper } = await mountScreen(InstallModal, '/library', api, {
      kind: 'mcp',
      id: 'playwright',
      name: 'playwright',
      open: true,
    })
    await flushPromises()
    expect(button(wrapper, 'Install')!.attributes('disabled')).toBeDefined()
    wrapper.findComponent(SelectField).vm.$emit('update:modelValue', 'odin')
    await flushPromises()
    await button(wrapper, 'Install')!.trigger('click')
    await flushPromises()
    expect((await api.listInstallations('odin')).some(i => i.id === 'playwright')).toBe(true)
    expect(wrapper.emitted('installed')).toHaveLength(1)
  })
})

describe('plugins', () => {
  it('has a Plugins tab with an Import action', async () => {
    const { wrapper } = await mountScreen(LibraryScreen, '/library?kind=plugin')
    await flushPromises()
    expect(wrapper.text()).toContain('Release helper')
    expect(button(wrapper, 'Import…')).toBeTruthy()
  })

  it('shows a plugin page with its own and included members and an export action', async () => {
    const { wrapper } = await mountScreen(
      AssetScreen,
      '/library/plugin/release-helper',
      undefined,
      {
        kind: 'plugin',
        id: 'release-helper',
      },
    )
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('release-notes')
    expect(text).toContain('triage')
    expect(text).toContain('follows the current version')
    expect(button(wrapper, 'Export…')).toBeTruthy()
    expect(button(wrapper, 'Install into…')).toBeTruthy()
  })

  it('reviews a plugin before installing it and sends the confirm token', async () => {
    const api = createMockApi()
    const install = vi.spyOn(api, 'install')
    const { wrapper } = await mountScreen(InstallModal, '/library', api, {
      kind: 'plugin',
      id: 'release-helper',
      name: 'Release helper',
      open: true,
    })
    await flushPromises()
    expect(button(wrapper, 'Install')).toBeUndefined()
    wrapper.findComponent(SelectField).vm.$emit('update:modelValue', 'odin')
    await flushPromises()
    await button(wrapper, 'Review')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('./guard.sh')
    expect(wrapper.text()).toContain('https://publish.example.com/mcp')
    expect((await api.listInstallations('odin')).some(i => i.id === 'release-helper')).toBe(false)
    await button(wrapper, 'Install')!.trigger('click')
    await flushPromises()
    const last = install.mock.calls.at(-1)!
    expect(last[1].action).toBe('install')
    expect(last[1].confirm).toMatch(/^[0-9a-f]{16}$/)
    expect((await api.listInstallations('odin')).some(i => i.id === 'release-helper')).toBe(true)
    expect(wrapper.emitted('installed')).toHaveLength(1)
  })

  it('imports in two steps: review first, then write', async () => {
    const api = createMockApi()
    const confirm = vi.spyOn(api, 'confirmPluginImport')
    const { wrapper } = await mountScreen(ImportPluginModal, '/library', api, { open: true })
    await flushPromises()
    await wrapper.find('dialog input').setValue('https://github.com/acme/ship-it.git')
    await button(wrapper, 'Review')!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('npx @modelcontextprotocol/server-github')
    expect(wrapper.text()).toContain('GITHUB_TOKEN')
    expect(confirm).not.toHaveBeenCalled()
    expect((await api.listLibrary('plugin')).some(a => a.id === 'ship-it')).toBe(false)
    await button(wrapper, 'Import “ship-it”')!.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('imported')).toEqual([['ship-it']])
    expect((await api.listLibrary('plugin')).some(a => a.id === 'ship-it')).toBe(true)
  })
})

describe('SaveToLibraryModal', () => {
  const session: SessionSource = {
    title: 'Fix the History filter',
    tags: [],
    model: 'opus',
    permissionMode: null,
    agent: null,
    workspace: { kind: 'checkout' },
    transcript: [
      { kind: 'user', id: 'u1', text: 'Fix the filter', at: null, parentToolUseId: null },
    ],
  }

  it('saves reusable task text as a skill', async () => {
    const api = createMockApi()
    const { wrapper } = await mountScreen(SaveToLibraryModal, '/', api, { session, open: true })
    await flushPromises()
    await button(wrapper, 'Save')!.trigger('click')
    await flushPromises()
    const saved = await api.getAsset('skill', 'fix-the-history-filter')
    expect(Object.values(saved.files)[0]).toContain('Fix the filter')
    expect(wrapper.emitted('saved')![0]).toEqual(['skill', 'fix-the-history-filter'])
  })

  it('does not save runtime settings or a primary-agent selection in the skill', async () => {
    const api = createMockApi()
    const { wrapper } = await mountScreen(SaveToLibraryModal, '/', api, { session, open: true })
    await flushPromises()
    await button(wrapper, 'Save')!.trigger('click')
    await flushPromises()
    const saved = await api.getAsset('skill', 'fix-the-history-filter')
    expect(Object.keys(saved.files)).toEqual(['SKILL.md'])
    expect(saved.files['SKILL.md']).not.toContain('opus')
    expect(wrapper.findAll('[role=tab]')).toHaveLength(0)
  })

  it('refuses an id that is taken', async () => {
    const { wrapper } = await mountScreen(SaveToLibraryModal, '/', createMockApi(), {
      session: { ...session, title: 'Fix issue' },
      open: true,
    })
    await flushPromises()
    expect(wrapper.text()).toContain('already one called "fix-issue"')
    expect(button(wrapper, 'Save')!.attributes('disabled')).toBeDefined()
  })
})
