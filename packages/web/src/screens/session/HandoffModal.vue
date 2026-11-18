<script setup lang="ts">
// Hand a session off to another harness: pick the target, review the briefing it will start with (editable), and go.
// The server builds the briefing and starts the new session on the same checkout; this only collects the choices.
import { computed, ref, watch } from 'vue'
import type { HandoffPreview, HandoffRequest, HarnessInfo, Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuSwitch, IuTextarea } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'
import SelectField from '@/screens/shared/SelectField.vue'
import { harnessLabel } from '@/screens/shared/format'

const props = defineProps<{
  sessionId: string
  harness: string
  /** Running or waiting sessions can be previewed but not handed off: both would share one checkout. */
  busy: boolean
  /** An ended or failed session has nothing left to end. */
  final: boolean
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ handedOff: [session: Session] }>()

const api = useApi()
const harnesses = ref<HarnessInfo[]>([])
const target = ref('')
const model = ref('')
const brief = ref('')
const endSource = ref(true)
const preview = ref<HandoffPreview | null>(null)
const loading = ref(false)
const sending = ref(false)
const error = ref<string | null>(null)
let request = 0

const others = computed(() => harnesses.value.filter(h => h.id !== props.harness))
const targetOptions = computed(() =>
  others.value.map(h => ({ id: h.id, label: h.available ? h.name : `${h.name} (unavailable)` })),
)
const modelOptions = computed(() => [
  { id: '', label: 'Default model' },
  ...(preview.value?.target.models ?? []).map(m => ({ id: m.value, label: m.displayName })),
])
const unavailable = computed(() =>
  preview.value && !preview.value.target.available ? preview.value : null,
)
const files = computed(() => preview.value?.files.length ?? 0)
const canSend = computed(
  () =>
    !props.busy &&
    !!preview.value?.target.available &&
    !!brief.value.trim() &&
    !loading.value &&
    !sending.value,
)

async function loadPreview() {
  const mine = ++request
  if (!target.value) return
  loading.value = true
  error.value = null
  try {
    const next = await api.handoffPreview(props.sessionId, target.value)
    if (mine !== request) return
    preview.value = next
    brief.value = next.brief
    model.value = ''
  } catch (e) {
    if (mine !== request) return
    preview.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (mine === request) loading.value = false
  }
}

// a fresh form every time it opens
watch(
  open,
  async isOpen => {
    if (!isOpen) return
    preview.value = null
    brief.value = ''
    error.value = null
    endSource.value = true
    try {
      harnesses.value = (await api.getSettings()).harnesses
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      return
    }
    const first = others.value.find(h => h.available) ?? others.value[0]
    target.value = first?.id ?? ''
    if (target.value) await loadPreview()
  },
  { immediate: true },
)

watch(target, (next, prev) => {
  if (open.value && next && prev !== undefined && next !== prev) void loadPreview()
})

async function handOff() {
  if (!canSend.value) return
  sending.value = true
  error.value = null
  const req: HandoffRequest = {
    harness: target.value,
    brief: brief.value.trim(),
    endSource: endSource.value,
  }
  if (model.value) req.model = model.value
  try {
    const session = await api.handoffSession(props.sessionId, req)
    open.value = false
    emit('handedOff', session)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" size="lg">
    <template #header>
      <h2 class="handoff-modal__title">Hand off to another harness</h2>
    </template>
    <form class="handoff-modal__form" @submit.prevent="handOff">
      <p class="handoff-modal__note">
        This starts a new {{ target ? harnessLabel(target) : '' }} session in the same folder and
        branch, so it sees every file as {{ harnessLabel(harness) }} left it. It has none of the
        conversation, only the briefing below. Edit the briefing if something is missing.
      </p>
      <IuCallout v-if="busy" intent="warning" variant="inline" live>
        Stop this session first: both would be editing the same files.
      </IuCallout>
      <div class="handoff-modal__row">
        <SelectField v-model="target" label="Hand off to" :options="targetOptions" />
        <SelectField
          v-if="preview?.target.models.length"
          v-model="model"
          label="Model"
          :options="modelOptions"
        />
      </div>
      <IuCallout v-if="unavailable" intent="warning" variant="inline">
        {{ unavailable.target.name }} isn’t available here{{
          unavailable.target.note ? `: ${unavailable.target.note}` : ''
        }}.
      </IuCallout>
      <IuTextarea
        v-model="brief"
        label="Briefing"
        :rows="12"
        :disabled="loading || !preview"
        :hint="
          loading
            ? 'Writing the briefing…'
            : files
              ? `${files} changed ${files === 1 ? 'file' : 'files'} in the working tree are listed in it.`
              : 'Built from the task, the last summary, the plan and the working tree.'
        "
      />
      <IuSwitch v-if="!final" v-model="endSource" label="End this session after handing off" />
      <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    </form>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="sending" @click="open = false"
        >Cancel</IuButton
      >
      <IuButton variant="primary" size="sm" :loading="sending" :disabled="!canSend" @click="handOff"
        >Hand off</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.handoff-modal__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.handoff-modal__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.handoff-modal__note {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.handoff-modal__row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
</style>
