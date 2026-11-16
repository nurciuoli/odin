import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import type { TranscriptEntry } from '@odin/shared/harness'
import SessionThread from './SessionThread.vue'
import { buildRows, injectedLabel } from './sessionView'

const ctx = { pending: [], streaming: [], running: false, artifacts: [] }

// The owner's example, as the Claude driver maps it: a subagent hand-back.
const handBack: TranscriptEntry = {
  kind: 'injected',
  id: 'h1',
  source: 'agent',
  from: 'reviewer',
  text: 'Fixed the bug; tests pass.',
  at: null,
  parentToolUseId: null,
}
const typed: TranscriptEntry = {
  kind: 'user',
  id: 'u1',
  text: 'Another Claude session sent a message: is quoted here',
  at: null,
  parentToolUseId: null,
}

describe('injected messages', () => {
  it('label by source, never as the user', () => {
    expect(injectedLabel({ source: 'agent', from: 'reviewer' })).toBe('Agent report from reviewer')
    expect(injectedLabel({ source: 'agent', from: null })).toBe('Agent report')
    expect(injectedLabel({ source: 'task', from: null })).toBe('Background task finished')
    expect(injectedLabel({ source: 'system', from: null })).toBe('System notice')
    expect(injectedLabel({ source: 'peer', from: 'ops' })).toBe('Message from session ops')
  })

  it('become their own rows and break the author run', () => {
    const rows = buildRows([typed, handBack, { ...typed, id: 'u2' }], ctx)
    expect(rows.map(r => r.kind)).toEqual(['user', 'injected', 'user'])
    const last = rows[2]!
    expect(last.kind === 'user' && last.head).toBe(true)
  })

  it('render collapsed with their label, not as "You", and expand to the body', async () => {
    const wrapper = mount(SessionThread, {
      props: { rows: buildRows([handBack], ctx), working: false },
    })
    const details = wrapper.find('details.injected-notice')
    expect(details.exists()).toBe(true)
    expect(details.attributes('open')).toBeUndefined()
    expect(wrapper.find('summary').text()).toBe('Agent report from reviewer')
    expect(wrapper.text()).not.toContain('You')
    expect(wrapper.find('.iu-msg--user, [data-role="user"]').exists()).toBe(false)
    expect(details.find('.injected-notice__body').text()).toContain('Fixed the bug; tests pass.')
  })

  it("keep the user's typed text as the user's turn", () => {
    const wrapper = mount(SessionThread, {
      props: { rows: buildRows([typed], ctx), working: false },
    })
    expect(wrapper.find('details.injected-notice').exists()).toBe(false)
    expect(wrapper.text()).toContain('You')
  })
})
