import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createMockApi } from '@/api/mock'
import { mountScreen } from '@/screens/shared/testSupport'
import HandoffModal from './HandoffModal.vue'

afterEach(() => {
  document.body.innerHTML = ''
})

async function mountModal(props: { busy?: boolean; final?: boolean } = {}) {
  const api = createMockApi()
  const session = await api.getSession(FIXTURE_SESSION_IDS.idle)
  const ctx = await mountScreen(HandoffModal, `/s/${session.id}`, api, {
    open: true,
    sessionId: session.id,
    harness: session.harness,
    busy: props.busy ?? false,
    final: props.final ?? false,
  })
  await flushPromises()
  return { ...ctx, api, session }
}

const textarea = () => document.querySelector<HTMLTextAreaElement>('textarea')!
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    b => b.textContent?.trim() === label,
  )!

it('loads the briefing for the first other harness and hands off with the edited text', async () => {
  const { wrapper, api, session, sessions, projects } = await mountModal()
  const preview = vi.spyOn(api, 'handoffPreview')
  expect(textarea().value).toContain('## Task')
  expect(textarea().value).toContain('Handoff from Claude')
  textarea().value = 'only do the lexer'
  textarea().dispatchEvent(new Event('input'))
  await flushPromises()

  const handoff = vi.spyOn(api, 'handoffSession')
  button('Hand off').click()
  await flushPromises()
  expect(handoff).toHaveBeenCalledWith(session.id, {
    harness: 'opencode',
    brief: 'only do the lexer',
    endSource: true,
  })
  expect(wrapper.emitted('handedOff')?.[0]?.[0]).toMatchObject({
    harness: 'opencode',
    parentId: session.id,
  })
  expect(preview).not.toHaveBeenCalled()
  wrapper.unmount()
  sessions.stop()
  projects.stop()
})

it('will not hand off a running session, and shows why', async () => {
  const { wrapper, sessions, projects } = await mountModal({ busy: true })
  expect(document.body.textContent).toContain('Stop this session first')
  expect(button('Hand off').disabled).toBe(true)
  wrapper.unmount()
  sessions.stop()
  projects.stop()
})
