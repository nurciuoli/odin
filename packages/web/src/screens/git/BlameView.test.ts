import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { API_KEY } from '@/api'
import { createMockApi } from '@/api/mock'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import BlameView from './BlameView.vue'
import FileHistory from './FileHistory.vue'

const target = { kind: 'session' as const, id: FIXTURE_SESSION_IDS.waiting }
const source = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')

describe('BlameView', () => {
  it('names each run of lines once, and opens the commit on click', async () => {
    const api = createMockApi()
    const w = mount(BlameView, {
      props: { target, path: 'packages/web/src/screens/session/SessionSide.vue', source },
      global: { provide: { [API_KEY as symbol]: api } },
    })
    await flushPromises()
    expect(w.findAll('.git-blame__row')).toHaveLength(30)
    const buttons = w.findAll('.git-blame__who-button')
    expect(buttons.length).toBeLessThan(30)
    expect(buttons[0]!.text()).toContain('nick')
    expect(w.text()).toContain('Who wrote this file')
    await buttons[0]!.trigger('click')
    expect(String(w.emitted('commit')?.[0]?.[0])).toMatch(/^[0-9a-f]{7,40}$/)
    w.unmount()
  })
})

describe('FileHistory', () => {
  it('lists the commits and shows the first one', async () => {
    const api = createMockApi()
    const w = mount(FileHistory, {
      props: { target, path: 'packages/web/src/screens/session/SessionSide.vue' },
      global: { provide: { [API_KEY as symbol]: api } },
    })
    await flushPromises()
    const rows = w.findAll('[role="option"]')
    expect(rows.length).toBeGreaterThan(3)
    expect(rows[0]!.attributes('aria-selected')).toBe('true')
    expect(w.findAll('.git-diff__hunk').length).toBeGreaterThan(0)
    w.unmount()
  })
})
