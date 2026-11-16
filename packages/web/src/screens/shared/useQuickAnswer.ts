// Allow or deny a session's open tool prompt from outside the session (Home's rows, the session header's waiting
// list): one answer at a time, "once" scope, a toast when it fails. Questions and plans are answered in the session.
import { ref, type Ref } from 'vue'
import type { PermissionRequest } from '@odin/shared/harness'
import { useApi } from '@/api'
import { useToast } from '@/components/Toast'

export interface QuickAnswer {
  /** The prompt id being answered, while the request is in flight. */
  answering: Ref<string | null>
  /** true when the answer went through. */
  answer(sessionId: string, prompt: PermissionRequest, allow: boolean): Promise<boolean>
}

export function useQuickAnswer(): QuickAnswer {
  const api = useApi()
  const { toast } = useToast()
  const answering = ref<string | null>(null)

  async function answer(sessionId: string, prompt: PermissionRequest, allow: boolean) {
    if (answering.value) return false
    answering.value = prompt.id
    try {
      await api.answerPermission(
        sessionId,
        prompt.id,
        allow ? { behavior: 'allow', scope: 'once' } : { behavior: 'deny' },
      )
      return true
    } catch (e) {
      toast({
        title: allow ? "Couldn't allow it" : "Couldn't deny it",
        description: e instanceof Error ? e.message : String(e),
        intent: 'danger',
      })
      return false
    } finally {
      answering.value = null
    }
  }

  return { answering, answer }
}
