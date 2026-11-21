import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createMockApi } from '@/api/mock'
import { resetDrafts } from '@/app/drafts'
import NewSessionForm from './NewSessionForm.vue'
import { mountScreen } from './testSupport'

async function mountForm(api = createMockApi()) {
  const ctx = await mountScreen(NewSessionForm, '/', api, { project: 'odin' })
  await flushPromises()
  const chip = () => ctx.wrapper.find('button[aria-label^="Where it runs:"]')
  const send = async (text: string) => {
    await ctx.wrapper.find('textarea').setValue(text)
    await ctx.wrapper.find('button[aria-label="Send"]').trigger('click')
    await flushPromises()
  }
  return { ...ctx, api, chip, send }
}

const worktreePath = '/home/me/.odin/worktrees/odin/odin-permission-prompt-7b2d4e81'

describe('NewSessionForm where it runs', () => {
  beforeEach(() => {
    localStorage.removeItem('odin:draft:new')
    resetDrafts()
  })

  it('sends an existing worktree and warns when a session already runs there', async () => {
    const { wrapper, api, chip, send } = await mountForm()
    expect(wrapper.find('.new-session__shared').exists()).toBe(false)
    await chip().trigger('click')
    await wrapper.find('[data-where="worktree"]').trigger('click')
    await flushPromises()
    expect(chip().text()).toContain('odin-permission-prompt-7b2d4e81')
    const note = wrapper.find('.new-session__shared')
    const warning = note.get('button[aria-label="1 session already running here"]')
    const panel = note.get('.new-session__shared-panel')
    expect(warning.attributes('aria-expanded')).toBe('false')
    expect(panel.isVisible()).toBe(false)
    await note.trigger('pointerenter')
    expect(warning.attributes('aria-expanded')).toBe('true')
    expect(panel.isVisible()).toBe(true)
    expect(note.find('a').text()).toBe('Permission prompt component')
    await note.trigger('pointerleave')
    expect(panel.isVisible()).toBe(false)
    const spy = vi.spyOn(api, 'startSession')
    await send('Go')
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: 'worktree', path: worktreePath } }),
    )
    const call = spy.mock.calls[0]![0]
    expect(call.worktree).toBeUndefined()
    expect(call.branch).toBeUndefined()
  })

  it('"Use a new worktree" in the notice switches the place', async () => {
    const { wrapper, chip } = await mountForm()
    await chip().trigger('click')
    await wrapper.find('[data-where="worktree"]').trigger('click')
    await flushPromises()
    const warning = wrapper.get('button[aria-label="1 session already running here"]')
    await warning.trigger('click')
    expect(warning.attributes('aria-expanded')).toBe('true')
    await wrapper.get('.new-session__shared-use').trigger('keydown', { key: 'Escape' })
    expect(warning.attributes('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(warning.element)
    await warning.trigger('click')
    await wrapper.get('.new-session__shared-use').trigger('click')
    expect(chip().text()).toContain('New worktree')
    expect(wrapper.find('.new-session__shared').exists()).toBe(false)
  })

  it('sends an existing branch', async () => {
    const api = createMockApi()
    const base = (await api.listProjectBranches('odin'))[0]!
    const branch = { ...base, name: 'fix/free', current: false, worktreePath: null }
    api.listProjectBranches = async () => [base, branch]
    const { wrapper, chip, send } = await mountForm(api)
    await chip().trigger('click')
    await wrapper.find('input[placeholder="Filter branches"]').setValue(branch.name)
    await wrapper.find('[data-where="branch"]').trigger('click')
    expect(chip().text()).toContain(`⎇ ${branch.name} · new worktree`)
    const spy = vi.spyOn(api, 'startSession')
    await send('Go')
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: 'branch', branch: branch.name } }),
    )
  })
})
