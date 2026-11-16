import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountScreen } from '@/screens/shared/testSupport'
import SettingsScreen from './SettingsScreen.vue'
import { createMockApi } from '@/api/mock'

const switches = (w: { findAll: (s: string) => unknown[] }) =>
  w.findAll('[role="switch"]') as {
    trigger: (e: string) => Promise<void>
    attributes: (k: string) => string | undefined
  }[]

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function settle() {
  await vi.advanceTimersByTimeAsync(0)
  await flushPromises()
}

describe('SettingsScreen', () => {
  it('shows the sections, harness rows, prices, GitHub and the library path', async () => {
    const { wrapper } = await mountScreen(SettingsScreen, '/settings')
    await settle()
    const text = wrapper.text()
    for (const s of ['New sessions', 'Harnesses', 'Notifications', 'Pricing', 'Connections'])
      expect(text).toContain(s)
    expect(text).not.toContain('Open in editor')
    expect(text).toContain('Claude Code')
    expect(text).toContain('Found')
    expect(text).toContain('Default')
    expect(text).toContain('Token from')
    expect(text).toContain('/home/me/.odin/library')
    expect(text).toContain('Saved')
    expect(text).not.toContain('Save changes')
  })

  it('reveals a harness row with a disclosure button', async () => {
    const { wrapper } = await mountScreen(SettingsScreen, '/settings')
    await settle()
    const toggle = wrapper.find('button[aria-label="Claude Code settings"]')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('input[placeholder="claude on PATH"]').exists()).toBe(false)
    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('#app-settings-tool-claude').exists()).toBe(true)
    expect(wrapper.find('input[placeholder="claude on PATH"]').exists()).toBe(true)
  })

  it('saves a switch immediately and shows the status line', async () => {
    const { api, wrapper } = await mountScreen(SettingsScreen, '/settings')
    await settle()
    const spy = vi.spyOn(api, 'updateSettings')
    await switches(wrapper)[0]!.trigger('click')
    expect(spy).toHaveBeenCalledTimes(1)
    await settle()
    expect((await api.getSettings()).settings.defaultWorktree).toBe(true)
    expect(wrapper.find('[role="status"]').text()).toContain('Saved')
  })

  it('saves a text field after it sits idle, and on blur', async () => {
    const { api, wrapper } = await mountScreen(SettingsScreen, '/settings')
    await settle()
    const spy = vi.spyOn(api, 'updateSettings')
    await wrapper.find('button[aria-label="Git settings"]').trigger('click')
    const input = wrapper.find('input[placeholder="git on PATH"]')
    await input.setValue('/usr/bin/git')
    expect(spy).not.toHaveBeenCalled()
    expect(wrapper.find('[role="status"]').text()).toContain('Saving…')
    await vi.advanceTimersByTimeAsync(900)
    await flushPromises()
    expect(spy).toHaveBeenCalledTimes(1)
    expect((await api.getSettings()).settings.toolPaths).toEqual({ git: '/usr/bin/git' })

    await input.setValue('/opt/git')
    await input.trigger('focusout')
    await settle()
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('does not save an invalid value and says why', async () => {
    const { api, wrapper } = await mountScreen(SettingsScreen, '/settings')
    await settle()
    const spy = vi.spyOn(api, 'updateSettings')
    await wrapper.find('button[aria-label="GitHub CLI settings"]').trigger('click')
    await wrapper.find('input[placeholder="gh on PATH"]').setValue('gh')
    await vi.advanceTimersByTimeAsync(900)
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Use an absolute path')
    expect(wrapper.find('[role="status"]').text()).toContain(
      'Not saved: fix the highlighted fields',
    )
  })

  it('refuses a bad price and shows which row', async () => {
    const { api, wrapper } = await mountScreen(SettingsScreen, '/settings')
    await settle()
    const before = (await api.getSettings()).pricing
    const output = wrapper.findAll('input[type="number"]')[1]!
    await output.setValue('-3')
    await output.trigger('focusout')
    await settle()
    expect(wrapper.text()).toContain('Prices are numbers')
    expect((await api.getSettings()).pricing).toEqual(before)
  })

  it('never overlaps saves: an edit during a save runs once more afterwards', async () => {
    const api = createMockApi()
    const real = api.updateSettings.bind(api)
    let release: () => void = () => {}
    let inflight = 0
    let maxInflight = 0
    let calls = 0
    api.updateSettings = async req => {
      calls++
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      if (calls === 1) await new Promise<void>(r => (release = r))
      try {
        return await real(req)
      } finally {
        inflight--
      }
    }
    const { wrapper } = await mountScreen(SettingsScreen, '/settings', api)
    await settle()
    const sw = switches(wrapper)
    await sw[0]!.trigger('click')
    expect(calls).toBe(1)
    await sw[1]!.trigger('click')
    expect(calls).toBe(1)
    release()
    await settle()
    expect(calls).toBe(2)
    expect(maxInflight).toBe(1)
    const saved = await api.getSettings()
    expect(saved.settings.defaultWorktree).toBe(true)
    expect(saved.settings.notifyOnWaiting).toBe(false)
  })

  it('shows a failed save in the status line and keeps the value', async () => {
    const api = createMockApi()
    api.updateSettings = () => Promise.reject(new Error('disk full'))
    const { wrapper } = await mountScreen(SettingsScreen, '/settings', api)
    await settle()
    await switches(wrapper)[0]!.trigger('click')
    await settle()
    expect(wrapper.find('[role="status"]').text()).toContain('disk full')
    expect(switches(wrapper)[0]!.attributes('aria-checked')).toBe('true')
  })

  it('flushes a pending edit when the screen goes away', async () => {
    const { api, wrapper } = await mountScreen(SettingsScreen, '/settings')
    await settle()
    const spy = vi.spyOn(api, 'updateSettings')
    await wrapper.find('button[aria-label="Git settings"]').trigger('click')
    await wrapper.find('input[placeholder="git on PATH"]').setValue('/usr/bin/git')
    wrapper.unmount()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('adds a model row', async () => {
    const { wrapper } = await mountScreen(SettingsScreen, '/settings')
    await settle()
    const rows = wrapper.findAll('.app-settings__price-row').length
    await wrapper
      .findAll('button')
      .find(b => b.text() === 'Add model')!
      .trigger('click')
    expect(wrapper.findAll('.app-settings__price-row').length).toBe(rows + 1)
  })

  it('shows the error with a retry when loading fails', async () => {
    const api = createMockApi()
    api.getSettings = () => Promise.reject(new Error('boom'))
    const { wrapper } = await mountScreen(SettingsScreen, '/settings', api)
    await settle()
    expect(wrapper.text()).toContain("Couldn't load the settings")
    expect(wrapper.text()).toContain('boom')
  })
})
