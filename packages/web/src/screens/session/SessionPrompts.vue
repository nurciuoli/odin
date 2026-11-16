<script setup lang="ts">
// Open prompts (permission checks, plans, questions), one at a time and oldest first, in the message box's place
// (SessionComposer's `replacement` slot). Several waiting: "1 of 3" says how many are queued. Answering one posts it
// and waits for the `permission.resolved` event to take it away; the controls stay disabled while the answer is in
// flight. Cancel interrupts the turn; the harness then resolves the open requests as cancelled. A prompt appearing on
// its own never takes focus; the screen's live region announces it.
import { computed, ref } from 'vue'
import type { PermissionRequest } from '@odin/shared/harness'
import type { PermissionAnswerScope } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuPermissionPrompt, type PermissionPromptAnswer } from '@/components/PermissionPrompt'
import { useToast } from '@/components/Toast'
import { toPermissionAnswer, toPromptRequest } from './sessionView'
import NativeForm from './NativeForm.vue'
import { nativeForm, type NativeValue } from './nativeForm'

const props = defineProps<{
  sessionId: string
  pending: PermissionRequest[]
  scopes?: Exclude<PermissionAnswerScope, 'once'>[]
}>()

const api = useApi()
const { toast } = useToast()
const busy = ref<string[]>([])
const cancelling = ref(false)

const current = computed(() => props.pending[0] ?? null)
const form = computed(() => nativeForm(current.value?.input.nativeForm))

async function nativeAnswer(values: Record<string, NativeValue> | null) {
  const req = current.value
  if (!req || busy.value.includes(req.id)) return
  busy.value = [...busy.value, req.id]
  try {
    await api.answerPermission(
      props.sessionId,
      req.id,
      values === null
        ? { behavior: 'deny' }
        : { behavior: 'allow', scope: 'once', updatedInput: values },
    )
  } catch (e) {
    toast({
      title: "Couldn't send your answer",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    busy.value = busy.value.filter(id => id !== req.id)
  }
}

async function answer(req: PermissionRequest, a: PermissionPromptAnswer) {
  if (busy.value.includes(req.id)) return
  busy.value = [...busy.value, req.id]
  try {
    await api.answerPermission(props.sessionId, req.id, toPermissionAnswer(a, req))
  } catch (e) {
    toast({
      title: "Couldn't send your answer",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    busy.value = busy.value.filter(id => id !== req.id)
  }
}

async function cancel() {
  if (cancelling.value) return
  cancelling.value = true
  try {
    await api.interruptSession(props.sessionId)
  } catch (e) {
    toast({
      title: "Couldn't interrupt",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    cancelling.value = false
  }
}
</script>

<template>
  <div
    v-if="current"
    class="session-prompts"
    tabindex="-1"
    :aria-label="
      pending.length > 1
        ? `Waiting for your answer, 1 of ${pending.length}`
        : 'Waiting for your answer'
    "
  >
    <p v-if="pending.length > 1" class="session-prompts__count">
      <span class="session-prompts__num">1 of {{ pending.length }}</span> waiting for you
    </p>
    <NativeForm
      v-if="form"
      :key="current.id"
      :form="form"
      :busy="busy.includes(current.id) || cancelling"
      @answer="nativeAnswer"
      @cancel="nativeAnswer(null)"
    />
    <IuPermissionPrompt
      v-else
      :key="current.id"
      :request="toPromptRequest(current)"
      :busy="busy.includes(current.id) || cancelling"
      :scopes="scopes"
      :autofocus="false"
      cancellable
      cancel-label="Cancel and interrupt the agent"
      @answer="answer(current, $event)"
      @cancel="cancel"
    />
  </div>
</template>

<style>
.session-prompts {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.session-prompts:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
  border-radius: var(--iu-radius-lg);
}
.session-prompts__count {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.session-prompts__num {
  font-family: var(--iu-font-mono);
  color: var(--iu-text-2);
}
</style>
