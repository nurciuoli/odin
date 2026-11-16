<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { acceptWidgetMessage } from './widgetMessage'
const props = withDefaults(defineProps<{ kernelId: string; modelId: string }>(), {})
const api = useApi()
const enabled = ref(false)
const frame = ref<HTMLIFrameElement>()
const error = ref('')
const knownComms = new Set<string>()
let unsubscribe: (() => void) | undefined
let ready = false
let generation = 0
let pending = 0
function send(value: Record<string, unknown>) {
  frame.value?.contentWindow?.postMessage(
    { ...value, kernelId: props.kernelId, modelId: props.modelId },
    '*',
  )
}
async function receive(event: MessageEvent) {
  const accepted = acceptWidgetMessage(
    event,
    frame.value?.contentWindow ?? null,
    props.kernelId,
    props.modelId,
  )
  if (!enabled.value || !accepted) return
  const currentGeneration = generation
  try {
    if (accepted.type === 'odin.widget.ready') {
      if (ready) return
      ready = true
      const state = await api.notebookWidgetState(props.kernelId)
      if (currentGeneration !== generation) return
      state.forEach(message => knownComms.add(message.commId))
      send({ type: 'odin.widget.init', state })
    } else {
      if (!knownComms.has(accepted.message.commId)) throw new Error('Unknown widget model')
      if (pending >= 16) throw new Error('Too many pending widget callbacks')
      pending++
      try {
        await api.sendNotebookComm(props.kernelId, accepted.message)
      } finally {
        pending--
      }
      if (currentGeneration !== generation) return
      send({ type: 'odin.widget.ack', requestId: accepted.requestId })
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    if (accepted.type === 'odin.widget.comm')
      send({ type: 'odin.widget.ack', requestId: accepted.requestId, error: true })
  }
}
function disable() {
  generation++
  enabled.value = false
  ready = false
  unsubscribe?.()
  unsubscribe = undefined
  window.removeEventListener('message', receive)
  knownComms.clear()
}
function enable() {
  error.value = ''
  enabled.value = true
  ready = false
  window.addEventListener('message', receive)
  unsubscribe = api.subscribe(
    event => {
      if (event.type === 'notebook.comm' && event.kernelId === props.kernelId) {
        if (event.message.type === 'comm_open') knownComms.add(event.message.commId)
        send({ type: 'odin.widget.receive', message: event.message })
      }
    },
    () => {
      disable()
      error.value = 'Connection changed. Enable widgets again to reconnect.'
    },
  )
}
onBeforeUnmount(disable)
</script>
<template>
  <div class="notebook-widget">
    <template v-if="!enabled"
      ><p>Interactive widgets can run Python callbacks in this kernel.</p>
      <IuButton size="sm" @click="enable">Enable widgets</IuButton></template
    >
    <template v-else
      ><IuButton size="sm" variant="ghost" @click="disable">Disable widgets</IuButton
      ><iframe
        ref="frame"
        sandbox="allow-scripts allow-forms"
        :src="`/a/notebook-widgets/${encodeURIComponent(kernelId)}/${encodeURIComponent(modelId)}`"
        title="Interactive notebook widget"
    /></template>
    <p v-if="error" role="alert">{{ error }}</p>
  </div>
</template>
<style>
.notebook-widget iframe {
  width: 100%;
  min-height: 200px;
  border: 1px solid var(--iu-border-quiet);
  background: var(--iu-ground);
}
.notebook-widget p {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
</style>
