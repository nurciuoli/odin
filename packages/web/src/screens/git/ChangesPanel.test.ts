import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import ChangesPanel from './ChangesPanel.vue'

const target = { kind: 'session' as const, id: FIXTURE_SESSION_IDS.waiting }

describe('ChangesPanel: git actions', () => {
  it('shows a failing pre-commit action, and commits anyway when asked', async () => {
    const api = createMockApi()
    const w = mount(ChangesPanel, {
      props: { target },
      global: { provide: { [API_KEY as symbol]: api } },
      attachTo: document.body,
    })
    await flushPromises()
    await w.find('#git-commit-message').setValue('feat: prompt')
    await w.find('form.git-changes__commit').trigger('submit')
    await flushPromises()
    const blocked = w.find('.git-changes__blocked')
    expect(blocked.exists()).toBe(true)
    expect(blocked.text()).toContain('Run tests before commit failed')
    expect(blocked.text()).toContain('1 failed, 11 passed')
    expect(blocked.text()).not.toContain('Ask Claude to fix') // no session passed
    const anyway = blocked.findAll('button').find(b => b.text() === 'Commit anyway')!
    await anyway.trigger('click')
    await vi.waitFor(() => expect(w.find('.git-changes__blocked').exists()).toBe(false))
    expect((await api.gitLog(target, { limit: 1 })).commits[0]!.subject).toBe('feat: prompt')
    w.unmount()
  })
})
