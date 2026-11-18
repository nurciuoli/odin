import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { FIXTURE_SESSION_IDS } from '@/api/fixtures'
import { createMockApi } from '@/api/mock'
import { mountScreen } from '@/screens/shared/testSupport'
import HandoffPrompt from './HandoffPrompt.vue'
import {
  closeHandoff,
  findHarness,
  handoffCard,
  openHandoff,
  parseHandoffArgs,
  runHandoff,
} from './handoff'
import { mergeCommands, odinCommands, parseOdinCommand } from './slashCommands'

afterEach(() => {
  document.body.innerHTML = ''
  closeHandoff()
})

it('parses /handoff arguments and finds the harness by id or name', async () => {
  expect(parseHandoffArgs('')).toEqual({})
  expect(parseHandoffArgs('codex')).toEqual({ harness: 'codex' })
  expect(parseHandoffArgs(' codex  gpt 5 ')).toEqual({ harness: 'codex', model: 'gpt 5' })
  const { harnesses } = await createMockApi().getSettings()
  expect(findHarness(harnesses, 'CODEX')?.id).toBe('codex')
  expect(findHarness(harnesses, 'nope')).toBeUndefined()
  const cmds = odinCommands({ model: false })
  expect(parseOdinCommand('/handoff codex', mergeCommands(cmds, []))).toEqual({
    name: 'handoff',
    arg: 'codex',
  })
})

it('runs a full command without any card, and says what went wrong otherwise', async () => {
  const api = createMockApi()
  const id = FIXTURE_SESSION_IDS.idle
  const s = await runHandoff(api, id, 'codex')
  expect(s).toMatchObject({ harness: 'codex', parentId: id })
  await expect(runHandoff(api, id, 'nope')).rejects.toThrow(/No harness called “nope”/)
  const spy = vi.spyOn(api, 'handoffSession')
  await runHandoff(api, FIXTURE_SESSION_IDS.ended, 'codex', 'Mock model')
  expect(spy).toHaveBeenCalledTimes(1)
  expect(handoffCard.value).toBeNull()
})

it('bare /handoff shows a question card: pick a harness, then a model, then it hands off', async () => {
  const api = createMockApi()
  const id = FIXTURE_SESSION_IDS.idle
  const session = await api.getSession(id)
  const handoff = vi.spyOn(api, 'handoffSession')
  openHandoff(id)
  const { wrapper, sessions, projects } = await mountScreen(HandoffPrompt, `/s/${id}`, api, {
    sessionId: id,
    harness: session.harness,
  })
  await flushPromises()
  expect(document.body.textContent).toContain('Hand this session off to which harness?')
  const key = async (k: string) => {
    document
      .querySelector('.iu-question-carousel')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    await flushPromises()
  }
  await key('2') // Codex
  await key('Enter')
  expect(document.body.textContent).toMatch(/model\?/)
  await key('1') // Default model
  await key('Enter')
  expect(handoff).toHaveBeenCalledWith(id, { harness: 'codex' })
  expect(handoffCard.value).toBeNull()
  wrapper.unmount()
  sessions.stop()
  projects.stop()
})
