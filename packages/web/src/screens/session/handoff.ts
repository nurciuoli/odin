// Handing a session off to another harness from the composer: `/handoff [harness] [model]`. With a harness the handoff
// runs at once; bare `/handoff` opens a question card (HandoffPrompt) in the message box's place.
import { ref } from 'vue'
import type { HarnessInfo, Session } from '@odin/shared/api'
import type { Api } from '@/api/types'
import { harnessLabel } from '@/screens/shared/format'
import { resolveModel } from './slashCommands'

/** The session whose message box currently shows the handoff card. */
export const handoffCard = ref<string | null>(null)
export const openHandoff = (sessionId: string) => (handoffCard.value = sessionId)
export const closeHandoff = () => (handoffCard.value = null)

/** `codex gpt-5` → harness `codex`, model `gpt-5`. */
export function parseHandoffArgs(arg: string): { harness?: string; model?: string } {
  const [harness, ...rest] = arg.trim().split(/\s+/).filter(Boolean)
  const model = rest.join(' ')
  return { ...(harness ? { harness } : {}), ...(model ? { model } : {}) }
}

/** A harness by id, name or label, case-insensitively. */
export function findHarness(list: HarnessInfo[], word: string): HarnessInfo | undefined {
  const w = word.toLowerCase()
  return list.find(
    h =>
      h.id.toLowerCase() === w ||
      h.name.toLowerCase() === w ||
      harnessLabel(h.id).toLowerCase() === w,
  )
}

/** Hands `sessionId` off to the named harness (and model); rejects with a sentence the user can read. */
export async function runHandoff(
  api: Api,
  sessionId: string,
  harnessWord: string,
  modelWord?: string,
): Promise<Session> {
  const { harnesses } = await api.getSettings()
  const target = findHarness(harnesses, harnessWord)
  if (!target)
    throw new Error(
      `No harness called “${harnessWord}”. Try ${harnesses.map(h => h.id).join(', ')}.`,
    )
  let model: string | undefined
  if (modelWord) {
    const { target: t } = await api.handoffPreview(sessionId, target.id)
    model = resolveModel(modelWord, t.models) ?? undefined
  }
  return api.handoffSession(sessionId, { harness: target.id, ...(model ? { model } : {}) })
}
