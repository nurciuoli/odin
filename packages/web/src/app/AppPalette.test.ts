import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { mountScreen } from '@/screens/shared/testSupport'
import AppPalette from './AppPalette.vue'
import QuickLaunch from './QuickLaunch.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

async function openPalette() {
  const ctx = await mountScreen(AppPalette, '/', undefined, { open: false })
  await ctx.wrapper.setProps({ open: true })
  await flushPromises()
  await vi.waitFor(() => expect(ctx.wrapper.findAll('[role="option"]').length).toBeGreaterThan(2))
  return ctx
}
const labels = (w: Awaited<ReturnType<typeof openPalette>>['wrapper']) =>
  w.findAll('[role="option"]').map(o => o.find('.iu-cmdk__row-label').text())

describe('AppPalette', () => {
  it('lists sessions waiting first, then running, then recent, without side threads', async () => {
    const { wrapper, sessions, projects } = await openPalette()
    const rows = labels(wrapper)
    expect(rows[0]).toBe('Permission prompt component')
    expect(rows[1]).toBe('Session screen: streaming chat')
    expect(rows.some(r => r.startsWith('Side:'))).toBe(false)
    expect(wrapper.text()).toContain('Waiting')
    expect(wrapper.text()).toContain('Needs you ·')
    wrapper.unmount()
    sessions.stop()
    projects.stop()
  })

  it('matches on project titles too, and opens the chosen session', async () => {
    const { wrapper, router, sessions, projects } = await openPalette()
    const input = wrapper.find('input')
    await input.setValue('rick github')
    await vi.waitFor(() => expect(labels(wrapper)).toEqual(['Port the GitHub client']))
    await input.trigger('keydown', { key: 'Enter' })
    await vi.waitFor(
      () => expect(router.currentRoute.value.params.id).toBe(FIXTURE_SESSION_IDS.external),
      { timeout: 8000 },
    )
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    wrapper.unmount()
    sessions.stop()
    projects.stop()
  })

  it('offers actions after > and asks the shell for quick launch', async () => {
    const { wrapper, sessions, projects } = await openPalette()
    const input = wrapper.find('input')
    await input.setValue('>new')
    await vi.waitFor(() => expect(labels(wrapper)).toEqual(['New session']))
    await input.trigger('keydown', { key: 'Enter' })
    await vi.waitFor(() => expect(wrapper.emitted('quickLaunch')).toHaveLength(1))
    wrapper.unmount()
    sessions.stop()
    projects.stop()
  })
})

describe('QuickLaunch', () => {
  it("presets the open session's project and closes after a background start", async () => {
    const { wrapper, router, api, sessions, projects } = await mountScreen(
      QuickLaunch,
      `/s/${FIXTURE_SESSION_IDS.external}`,
      undefined,
      { open: false },
    )
    await wrapper.setProps({ open: true })
    await flushPromises()
    await vi.waitFor(() => expect(wrapper.find('textarea').exists()).toBe(true))
    const start = vi.spyOn(api, 'startSession')
    await wrapper.find('textarea').setValue('Check the client retries')
    await wrapper.find('textarea').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ project: 'rick' }))
    expect(wrapper.emitted('update:open')?.at(-1)).toEqual([false])
    expect(router.currentRoute.value.params.id).toBe(FIXTURE_SESSION_IDS.external)
    wrapper.unmount()
    sessions.stop()
    projects.stop()
  })
})
