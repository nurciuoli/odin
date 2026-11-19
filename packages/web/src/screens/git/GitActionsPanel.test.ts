import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountScreen } from '@/screens/shared/testSupport'
import GitActionsPanel from './GitActionsPanel.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('GitActionsPanel', () => {
  it("lists the repos' git actions, filters by trigger, and runs the picked one", async () => {
    const { wrapper, projects, sessions } = await mountScreen(GitActionsPanel, '/library')
    await vi.waitFor(() => expect(wrapper.findAll('.git-actions__row').length).toBe(5))
    expect(wrapper.emitted('count')?.at(-1)).toEqual([5])
    expect(wrapper.find('.git-actions__detail').text()).toContain('Run tests before commit')
    expect(wrapper.find('.git-actions__detail').text()).toContain('1 failed, 11 passed')
    await wrapper
      .findAll('[role="radio"]')
      .find(b => b.text() === 'Before push')!
      .trigger('click')
    expect(
      wrapper.findAll('.git-actions__row').map(r => r.find('.git-actions__title').text()),
    ).toEqual(['Typecheck before push'])
    const run = wrapper
      .find('.git-actions__detail')
      .findAll('button')
      .find(b => b.text().includes('Run now'))!
    await run.trigger('click')
    await vi.waitFor(() => expect(wrapper.find('.git-actions__detail').text()).toContain('passed'))
    wrapper.unmount()
    projects.stop()
    sessions.stop()
  })
})
