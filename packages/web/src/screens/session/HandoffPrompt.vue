<script setup lang="ts">
// Bare `/handoff`: a question card in the message box's place. Pick the harness, then (when it offers several) the
// model; the server writes the briefing and starts the new session. Esc or Cancel puts the message box back.
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { HarnessInfo, ModelInfo } from '@odin/shared/api'
import { useApi } from '@/api'
import {
  IuPermissionPrompt,
  type PermissionPromptAnswer,
  type PermissionPromptRequest,
} from '@/components/PermissionPrompt'
import { useToast } from '@/components/Toast'
import { closeHandoff } from './handoff'

const props = defineProps<{ sessionId: string; harness: string }>()

const api = useApi()
const router = useRouter()
const { toast } = useToast()

const choices = ref<HarnessInfo[]>([])
const models = ref<ModelInfo[]>([])
const target = ref<HarnessInfo | null>(null)
const busy = ref(false)
const ready = ref(false)

const DEFAULT_MODEL = 'Default model'

function fail(title: string, e?: unknown) {
  toast({
    title,
    description: e instanceof Error ? e.message : e ? String(e) : undefined,
    intent: 'warning',
  })
  closeHandoff()
}

async function go(model?: string) {
  if (!target.value) return
  busy.value = true
  try {
    const s = await api.handoffSession(props.sessionId, {
      harness: target.value.id,
      ...(model ? { model } : {}),
    })
    closeHandoff()
    void router.push(`/s/${s.id}`)
  } catch (e) {
    busy.value = false
    fail('Couldn’t hand off', e)
  }
}

async function pick(h: HarnessInfo) {
  target.value = h
  busy.value = true
  try {
    models.value = (await api.handoffPreview(props.sessionId, h.id)).target.models
  } catch (e) {
    return fail('Couldn’t hand off', e)
  }
  busy.value = false
  if (models.value.length > 1) return
  await go()
}

onMounted(async () => {
  try {
    choices.value = (await api.getSettings()).harnesses.filter(
      h => h.id !== props.harness && h.available,
    )
  } catch (e) {
    return fail('Couldn’t load the harnesses', e)
  }
  if (!choices.value.length) return fail('No other harness is available here')
  ready.value = true
  if (choices.value.length === 1) await pick(choices.value[0]!)
})

const request = computed<PermissionPromptRequest>(() =>
  target.value && models.value.length > 1
    ? {
        id: `handoff-model-${target.value.id}`,
        kind: 'question',
        tool: 'Handoff',
        title: 'Choose a model',
        questions: [
          {
            id: 'model',
            header: 'Model',
            question: `Which ${target.value.name} model?`,
            options: [
              { label: DEFAULT_MODEL },
              ...models.value.map(m => ({ label: m.displayName, description: m.description })),
            ],
          },
        ],
        canAlwaysAllow: false,
        defaultToDeny: false,
      }
    : {
        id: 'handoff-harness',
        kind: 'question',
        tool: 'Handoff',
        title: 'Choose a harness',
        questions: [
          {
            id: 'harness',
            header: 'Harness',
            question: 'Hand this session off to which harness?',
            options: choices.value.map(h => ({ label: h.name, description: h.note ?? undefined })),
          },
        ],
        canAlwaysAllow: false,
        defaultToDeny: false,
      },
)

async function onAnswer(a: PermissionPromptAnswer) {
  if (a.behavior !== 'allow' || busy.value) return
  if (request.value.id === 'handoff-harness') {
    const h = choices.value.find(c => c.name === a.answers?.harness)
    if (h) await pick(h)
  } else {
    const label = a.answers?.model
    const m = models.value.find(x => x.displayName === label)
    await go(label === DEFAULT_MODEL ? undefined : m?.value)
  }
}
</script>

<template>
  <IuPermissionPrompt
    v-if="ready"
    :key="request.id"
    :request="request"
    :busy="busy"
    :autofocus="false"
    cancellable
    choices-only
    cancel-label="Cancel handoff"
    @answer="onAnswer"
    @cancel="closeHandoff"
  />
</template>
