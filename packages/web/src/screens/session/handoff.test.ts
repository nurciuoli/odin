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

it('bare /handoff shows one line per harness; keys pick the harness, cycle its model and hand off', async () => {
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
  expect(document.activeElement).toBe(document.querySelector('.handoff-card'))
  const rows = () => [...document.querySelectorAll('.handoff-card__row')]
  expect(rows().map(r => r.querySelector('.handoff-card__name')?.textContent)).toEqual([
    'OpenCode',
    'Codex',
    'Grok',
    'Antigravity',
  ])
  const key = async (k: string, init: KeyboardEventInit = {}) => {
    document
      .querySelector('.handoff-card')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))
    await flushPromises()
  }
  const model = () => document.querySelector('.is-selected .handoff-card__modelname')?.textContent
  await key('2') // Codex
  expect(rows()[1]!.classList.contains('is-selected')).toBe(true)
  expect(model()).toBe('Default model')
  await key('ArrowRight')
  const first = model()
  expect(first).not.toBe('Default model')
  await key('Tab')
  expect(model()).not.toBe(first)
  await key('Tab', { shiftKey: true })
  expect(model()).toBe(first)
  await key('ArrowLeft')
  expect(model()).toBe('Default model')
  await key('ArrowRight')
  await key('Enter')
  expect(handoff).toHaveBeenCalledTimes(1)
  expect(handoff.mock.calls[0]![1]).toMatchObject({ harness: 'codex', model: expect.any(String) })
  expect(handoffCard.value).toBeNull()
  wrapper.unmount()
  sessions.stop()
  projects.stop()
})

it('Escape closes the card without handing off', async () => {
  const api = createMockApi()
  const id = FIXTURE_SESSION_IDS.idle
  const handoff = vi.spyOn(api, 'handoffSession')
  openHandoff(id)
  const { wrapper, sessions, projects } = await mountScreen(HandoffPrompt, `/s/${id}`, api, {
    sessionId: id,
    harness: 'claude',
  })
  await flushPromises()
  document
    .querySelector('.handoff-card')!
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(handoffCard.value).toBeNull()
  expect(handoff).not.toHaveBeenCalled()
  wrapper.unmount()
  sessions.stop()
  projects.stop()
})
