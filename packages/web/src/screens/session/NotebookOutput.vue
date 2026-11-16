<script setup lang="ts">
import { computed } from 'vue'
import type { NotebookOutput } from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuTerminalOutput } from '@/components/TerminalOutput'
import NotebookWidget from './NotebookWidget.vue'
const props = withDefaults(
  defineProps<{ output: NotebookOutput; kernelId: string; cellId: string; index: number }>(),
  {},
)
const api = useApi()
const widget = computed(() => {
  const value =
    props.output.type === 'display'
      ? props.output.data['application/vnd.jupyter.widget-view+json']
      : null
  return value &&
    typeof value === 'object' &&
    'model_id' in value &&
    typeof value.model_id === 'string'
    ? value.model_id
    : null
})
const image = computed(() => {
  if (props.output.type !== 'display') return null
  for (const mime of ['image/png', 'image/jpeg']) {
    const data = props.output.data[mime]
    if (
      typeof data === 'string' &&
      data.length <= 4 * 1024 * 1024 &&
      /^[A-Za-z0-9+/\s]*={0,2}$/.test(data)
    )
      return `data:${mime};base64,${data}`
  }
  return null
})
const rich = computed(
  () =>
    props.output.type === 'display' &&
    ('text/html' in props.output.data ||
      'application/javascript' in props.output.data ||
      'image/svg+xml' in props.output.data),
)
const plain = computed(() =>
  props.output.type === 'display'
    ? String(props.output.data['text/plain'] ?? 'Output is available in the notebook file.')
    : '',
)
</script>
<template>
  <IuTerminalOutput
    v-if="output.type === 'stream'"
    :text="output.text"
    :tone="output.name === 'stderr' ? 'error' : 'default'"
  />
  <IuTerminalOutput
    v-else-if="output.type === 'error'"
    :text="[`${output.name}: ${output.message}`, ...output.traceback].join('\n')"
    tone="error"
  />
  <NotebookWidget v-else-if="widget" :kernel-id="kernelId" :model-id="widget" />
  <img v-else-if="image" class="notebook-output__image" :src="image" alt="Cell plot" />
  <iframe
    v-else-if="rich"
    class="notebook-output__frame"
    sandbox="allow-scripts allow-forms"
    :src="api.notebookOutputUrl(kernelId, cellId, index)"
    title="Cell rich output"
  />
  <IuTerminalOutput v-else :text="plain" />
</template>
<style>
.notebook-output__image {
  display: block;
  max-width: 100%;
  height: auto;
}
.notebook-output__frame {
  width: 100%;
  min-height: 280px;
  border: 1px solid var(--iu-border-quiet);
  background: var(--iu-ground);
}
</style>
