import { shallowRef } from 'vue'
import type { UserMessage } from '@odin/shared/api'

interface Attempt {
  sessionId: string
  message: UserMessage
}
const prefix = 'odin:send-attempts'
function stored(): Attempt[] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(prefix) ?? '[]')
    return Array.isArray(value)
      ? value.filter(
          (a): a is Attempt =>
            !!a &&
            typeof a.sessionId === 'string' &&
            typeof a.message?.text === 'string' &&
            typeof a.message?.clientId === 'string',
        )
      : []
  } catch {
    return []
  }
}
// Persist the exact unresolved payload and key before sending. It remains explicitly recoverable after reload;
// retrying this request is safe even if its HTTP acknowledgement was lost after native delivery completed.
export const unresolvedMessages = shallowRef<Attempt[]>(stored())
function persist() {
  try {
    sessionStorage.setItem(prefix, JSON.stringify(unresolvedMessages.value))
  } catch {
    /* Memory recovery still works when browser storage is unavailable/full. */
  }
}
export function messageAttempt(sessionId: string, message: UserMessage): UserMessage {
  const { clientId: _clientId, ...payload } = message
  const signature = JSON.stringify(payload)
  const previous = unresolvedMessages.value.find(a => {
    const { clientId: _id, ...held } = a.message
    return a.sessionId === sessionId && JSON.stringify(held) === signature
  })
  if (previous) return previous.message
  const next = { ...payload, clientId: crypto.randomUUID() }
  unresolvedMessages.value = [...unresolvedMessages.value, { sessionId, message: next }]
  persist()
  return next
}
export function completeMessageAttempt(sessionId: string, clientId: string) {
  unresolvedMessages.value = unresolvedMessages.value.filter(
    a => a.sessionId !== sessionId || a.message.clientId !== clientId,
  )
  persist()
}
