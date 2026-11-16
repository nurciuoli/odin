<script setup lang="ts">
// An agent-written artifact, shown the only safe way: in an iframe that loads its own URL, sandboxed without
// the same-origin grant, so it can run scripts and forms but cannot touch this app. Its one channel back is
// `window.odin.submit`, which arrives here as a `message`; only the iframe's own window is believed (see
// artifactMessage.ts), and the user confirms before anything is sent into the session.
//
// The frame fills its container. The artifact column (ArtifactPanel) owns the chrome: tabs, title, the version
// picker and the width.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCodeBlock } from '@/components/CodeBlock'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import { IuSpinner } from '@/components/Spinner'
import { useToast } from '@/components/Toast'
import { acceptSubmit } from './artifactMessage'

const props = defineProps<{
  artifactId: number
  /** The version on show. */
  version: number
  title: string
}>()

const emit = defineEmits<{ answered: [session: Session] }>()

const api = useApi()
const { toast } = useToast()

// ── the frame ───────────────────────────────────────────────────────────────
const frame = ref<HTMLIFrameElement | null>(null)
const loaded = ref(false)
const src = computed(() => api.artifactUrl(props.artifactId, props.version))
watch(src, () => (loaded.value = false))

// ── submit → confirm → post ─────────────────────────────────────────────────
// shallow: the data is posted as it arrived, not as a reactive proxy of it
const pending = shallowRef<{ data: unknown; json: string; version: number } | null>(null)
const confirmOpen = ref(false)
const sending = ref(false)
const sendError = ref<string | null>(null)
const pendingPretty = computed(() =>
  pending.value ? JSON.stringify(pending.value.data, null, 2) : '',
)

function onMessage(event: MessageEvent) {
  const result = acceptSubmit(event, {
    source: frame.value?.contentWindow ?? null,
    artifactId: props.artifactId,
    version: props.version,
  })
  if (!result.ok) {
    // Only an answer from this very frame is worth a word; anything else is silently not ours.
    if (event.source && event.source === frame.value?.contentWindow && result.reason === 'size')
      toast({
        title: 'That answer is too large to send',
        description: 'Answers are limited to 64 KB.',
        intent: 'warning',
      })
    return
  }
  pending.value = { data: result.data, json: result.json, version: props.version }
  sendError.value = null
  confirmOpen.value = true
}

onMounted(() => window.addEventListener('message', onMessage))
onBeforeUnmount(() => window.removeEventListener('message', onMessage))

async function send() {
  if (!pending.value || sending.value) return
  sending.value = true
  sendError.value = null
  try {
    const session = await api.submitArtifact(
      props.artifactId,
      pending.value.version,
      pending.value.data,
    )
    confirmOpen.value = false
    pending.value = null
    emit('answered', session)
    toast({ title: 'Answer sent', description: 'It went into the session.', intent: 'success' })
  } catch (e) {
    sendError.value = e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}

function cancel() {
  confirmOpen.value = false
  pending.value = null
}
watch(confirmOpen, open => {
  if (!open && !sending.value) pending.value = null
})

// Escape closes the confirm dialog only, not a drawer the frame sits in.
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && confirmOpen.value) e.stopPropagation()
}
</script>

<template>
  <div class="artifact-frame" @keydown="onKeydown">
    <iframe
      :key="`${artifactId}/${version}`"
      ref="frame"
      class="artifact-frame__iframe"
      sandbox="allow-scripts allow-forms"
      :src="src"
      :title="`${title}, version ${version}`"
      @load="loaded = true"
    />
    <div v-if="!loaded" class="artifact-frame__loading" role="status">
      <IuSpinner :size="14" />
      <span>Loading artifact…</span>
    </div>

    <IuDialog v-model:open="confirmOpen" size="md">
      <template #header>
        <h2 class="artifact-frame__confirm-title">Send your answer to the session?</h2>
      </template>
      <p class="artifact-frame__confirm-note">
        This is what “{{ title }}” (v{{ pending?.version }}) wants to send. It goes to the agent as
        your next message.
      </p>
      <IuCodeBlock :code="pendingPretty" language="json" :copyable="false" max-height="240px" />
      <IuCallout
        v-if="sendError"
        intent="danger"
        variant="inline"
        live
        class="artifact-frame__confirm-error"
        >{{ sendError }}</IuCallout
      >
      <template #footer>
        <IuButton variant="secondary" size="sm" :disabled="sending" @click="cancel"
          >Cancel</IuButton
        >
        <IuButton variant="primary" size="sm" :loading="sending" @click="send"
          >Send answer</IuButton
        >
      </template>
    </IuDialog>
  </div>
</template>

<style>
.artifact-frame {
  position: relative;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--iu-ground);
}
.artifact-frame__iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  /* A page that sets no colours renders as on any web page (dark text on the light canvas), not dark-on-dark.
     Pages built with odin.theme paint their own background. */
  color-scheme: light;
  background: Canvas;
}
.artifact-frame__loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--iu-ground);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  pointer-events: none;
}
.artifact-frame__confirm-title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.artifact-frame__confirm-note {
  margin: 0 0 12px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.artifact-frame__confirm-error {
  margin-top: 12px;
}
</style>
