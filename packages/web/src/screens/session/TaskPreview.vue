<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { TaskActivity, TaskHistory } from '@odin/shared/harness'
import { taskKey } from '@odin/shared/harness'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuStatusDot } from '@/components/StatusDot'
import { IuTerminalOutput } from '@/components/TerminalOutput'
import SessionThread from './SessionThread.vue'
import { buildRows } from './sessionView'
import { taskStateLabel, taskStatus } from './activity'
const props = withDefaults(
  defineProps<{
    task: TaskActivity
    sessionId: string
    parentTitle: string
    harness: string
    modal?: boolean
    active?: boolean
  }>(),
  { modal: false, active: true },
)
const root = ref<HTMLElement>()
function focus() {
  root.value?.querySelector<HTMLButtonElement>('button')?.focus()
}
function onKeydown(event: KeyboardEvent) {
  if (!props.modal || event.key !== 'Tab') return
  const nodes = [
    ...(root.value?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], textarea:not([disabled]), input:not([disabled]), [tabindex="0"]',
    ) ?? []),
  ].filter(node => node.getClientRects().length > 0)
  const first = nodes[0]
  const last = nodes.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}
defineExpose({ focus })
const emit = defineEmits<{ close: [] }>()
const api = useApi()
const history = ref<TaskHistory | null>(null)
const loading = ref(false)
const error = ref('')
let request = 0
async function load() {
  if (!props.active || loading.value || props.task.kind !== 'agent') return
  const token = ++request
  loading.value = true
  error.value = ''
  try {
    const result = await api.getSessionTask(props.sessionId, taskKey(props.task))
    if (token === request) {
      history.value = result
      error.value = ''
    }
  } catch (e) {
    if (token === request) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (token === request) loading.value = false
  }
}
watch(
  () => JSON.stringify([props.sessionId, taskKey(props.task)]),
  () => {
    request++
    loading.value = false
    history.value = null
    void load()
  },
  { immediate: true },
)
// A lifecycle update can carry newer child output; refresh read-only history without changing selection.
watch(
  () => JSON.stringify([props.task.observedAt, props.task.state]),
  () => void load(),
)
watch(
  () => props.active,
  active => {
    if (active) void load()
  },
)
// Native parent events do not stream every child reply. Refresh only the selected running child.
const refreshTimer = setInterval(() => {
  if (props.task.state === 'running') void load()
}, 3000)
onBeforeUnmount(() => {
  clearInterval(refreshTimer)
  request++
})
const entries = computed(() =>
  history.value?.status === 'available' ? history.value.transcript : [],
)
const rows = computed(() =>
  buildRows(entries.value, { pending: [], streaming: [], running: false, artifacts: [] }),
)
</script>
<template>
  <section
    ref="root"
    class="task-preview"
    aria-label="Activity preview"
    :role="modal ? 'dialog' : undefined"
    :aria-modal="modal ? true : undefined"
    @keydown="onKeydown"
    @keydown.esc.stop.prevent="emit('close')"
  >
    <header class="task-preview__header">
      <div class="task-preview__heading">
        <span class="task-preview__parent"
          >{{ parentTitle }} / {{ task.kind === 'agent' ? 'Agent' : 'Command' }}</span
        ><strong>{{ task.label }}</strong
        ><span
          ><IuStatusDot :status="taskStatus(task.state)" decorative />
          {{ taskStateLabel(task) }}</span
        >
      </div>
      <IuButton variant="ghost" size="sm" @click="emit('close')">Close preview</IuButton>
    </header>
    <p v-if="task.summary" class="task-preview__summary">{{ task.summary }}</p>
    <template v-if="task.kind === 'command'">
      <IuTerminalOutput
        v-if="task.output"
        :text="task.output.text"
        :truncated="task.output.truncated"
      />
      <p v-else class="task-preview__summary">Command output is unavailable.</p>
    </template>
    <template v-else>
      <p v-if="loading && !history" role="status" class="task-preview__summary">
        Loading agent conversation…
      </p>
      <div v-else-if="error || history?.status === 'unavailable'" class="task-preview__summary">
        <p>{{ error || (history?.status === 'unavailable' ? history.reason : '') }}</p>
        <IuButton size="sm" variant="secondary" @click="load">Retry</IuButton>
      </div>
      <div v-else class="task-preview__refresh">
        <IuButton size="sm" variant="ghost" :disabled="loading" @click="load"
          >Refresh conversation</IuButton
        >
      </div>
      <SessionThread
        v-if="history?.status === 'available' && entries.length"
        :rows="rows"
        :entries="entries"
        :working="false"
        :harness="harness"
        :task-actions="false"
      />
      <p v-else-if="history?.status === 'available'" class="task-preview__summary">
        This agent has no messages yet.
      </p>
    </template>
  </section>
</template>
<style>
.task-preview {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}
.task-preview__header {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.task-preview__heading {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 6px;
  overflow-wrap: anywhere;
  font-size: var(--iu-font-size-12);
}
.task-preview__parent {
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.task-preview__summary {
  margin: 0;
  padding: 12px 16px;
  font-size: var(--iu-font-size-12);
}
.task-preview__refresh {
  padding: 4px 16px;
}
</style>
