import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountScreen } from '@/screens/shared/testSupport'
import { createMockApi } from '@/api/mock'
import { fakeDesktop } from '@/app/desktop'
import SettingsScreen from './SettingsScreen.vue'
import {
  formFromSettings,
  settingsRequest,
  toolPathError,
  toolPathWarning,
  validateToolPaths,
} from './settingsModel'

const button = (w: { findAll: (s: string) => { text: () => string }[] }, label: string) =>
  w.findAll('button').find(b => b.text() === label) as unknown as {
    trigger: (e: string) => Promise<void>
  }

afterEach(() => {
  delete window.odinDesktop
})

describe('desktop settings model', () => {
  it('sends only changed desktop settings, null for an off shortcut, trimmed tool paths', async () => {
    const saved = await createMockApi().getSettings()
    const f = formFromSettings(saved)
    expect(settingsRequest(f, saved)).toBeNull()
    f.notifyOnFinished = false
    f.shortcutOn = false
    f.editorCommand = ' cursor '
    f.toolPaths.gh = '  /usr/bin/gh '
    expect(settingsRequest(f, saved)?.settings).toEqual({
      notifyOnFinished: false,
      launcherShortcut: null,
      editorCommand: 'cursor',
      toolPaths: { gh: '/usr/bin/gh' },
    })
  })

  it('flags relative paths and warns on batch files', () => {
    expect(toolPathError('')).toBeNull()
    expect(toolPathError('C:\\tools\\gh.exe')).toBeNull()
    expect(toolPathError('/usr/bin/git')).toBeNull()
    expect(toolPathError('bin/gh')).toMatch(/absolute/)
    expect(
      validateToolPaths({
        claude: 'x',
        codex: '',
        grok: '',
        opencode: '',
        antigravity: '',
        gh: '',
        git: '',
      }),
    ).toHaveProperty('claude')
    expect(toolPathWarning('C:\\npm\\claude.CMD')).toMatch(/\.cmd or \.bat/)
    expect(toolPathWarning('C:\\npm\\claude.exe')).toBeNull()
  })
})

describe('SettingsScreen desktop section', () => {
  it('is hidden in a browser, but tool paths and notifications still show', async () => {
    const { wrapper } = await mountScreen(SettingsScreen, '/settings')
    await flushPromises()
    expect(wrapper.text()).not.toContain('Open in editor')
    expect(wrapper.text()).not.toContain('Open log')
    expect(wrapper.text()).toContain('A session finishes')
    expect(wrapper.text()).toContain('GitHub CLI')
    // what the claude harness check found
    expect(wrapper.text()).toContain('Auth comes from your Claude Code login')
  })

  it('shows the shell controls, toggles login, opens the log and reports a taken shortcut', async () => {
    const bridge = fakeDesktop({ taken: true })
    const setLogin = vi.spyOn(bridge, 'setLoginItem')
    const openLog = vi.spyOn(bridge, 'openLog')
    window.odinDesktop = bridge
    const { wrapper } = await mountScreen(SettingsScreen, '/settings')
    await flushPromises()
    expect(wrapper.text()).toContain('Desktop')
    expect(wrapper.text()).toContain('Taken by another app')
    const login = wrapper.findAll('button[role="switch"]').find(b => {
      const id = b.attributes('id')
      return wrapper.find(`label[for="${id}"]`).text().startsWith('Start at login')
    })!
    await login.trigger('click')
    await flushPromises()
    expect(setLogin).toHaveBeenCalledWith(true)
    await button(wrapper, 'Open log').trigger('click')
    expect(openLog).toHaveBeenCalled()
  })

  it('works with a shell that lacks the optional methods', async () => {
    window.odinDesktop = { platform: 'linux' }
    const { wrapper } = await mountScreen(SettingsScreen, '/settings')
    await flushPromises()
    expect(wrapper.text()).toContain('Editor command')
    expect(wrapper.text()).not.toContain('Start at login')
    expect(wrapper.text()).not.toContain('Open log')
  })

  it('warns on a .cmd override and shows the server error on save', async () => {
    const api = createMockApi()
    api.updateSettings = () => Promise.reject(new Error('toolPaths must be absolute paths'))
    const { wrapper } = await mountScreen(SettingsScreen, '/settings', api)
    await flushPromises()
    await wrapper.find('button[aria-label="Claude Code settings"]').trigger('click')
    const input = wrapper.find('input[placeholder="claude on PATH"]')
    await input.setValue('C:\\npm\\claude.cmd')
    expect(wrapper.text()).toContain("can't start .cmd or .bat")
    await input.trigger('focusout')
    await flushPromises()
    expect(wrapper.find('[role="status"]').text()).toContain('toolPaths must be absolute paths')
  })

  it('refuses a relative tool path before saving', async () => {
    const { api, wrapper } = await mountScreen(SettingsScreen, '/settings')
    await flushPromises()
    await wrapper.find('button[aria-label="GitHub CLI settings"]').trigger('click')
    const input = wrapper.find('input[placeholder="gh on PATH"]')
    await input.setValue('gh')
    await input.trigger('focusout')
    await flushPromises()
    expect(wrapper.text()).toContain('Use an absolute path')
    expect((await api.getSettings()).settings.toolPaths).toEqual({})
  })
})
