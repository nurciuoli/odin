<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MessageQueue, QueuedMessage } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuTextarea } from '@/components/Fields'

const props = withDefaults(defineProps<{ sessionId: string; queue: MessageQueue }>(), {})
const emit = defineEmits<{ updated: [queue: MessageQueue] }>()
const api = useApi()
const busy = ref(false)
const error = ref('')
const editing = ref<string | null>(null)
const text = ref('')
const confirming = ref<string | null>(null)
const hasUncertain = computed(() => props.queue.messages.some(m => m.state === 'uncertain'))
/** A handed-off message is already in the transcript. The queue shows what is still waiting. */
const visible = computed(() => props.queue.messages.filter(m => m.state !== 'sending'))
const nextQueued = computed(() => visible.value.some(m => m.state === 'queued'))
watch(
  () => props.sessionId,
  () => {
    editing.value = null
    confirming.value = null
    error.value = ''
  },
)
watch(
  () => props.queue.messages,
  messages => {
    if (!messages.some(m => m.id === editing.value && m.state === 'queued')) editing.value = null
  },
)
async function act(operation: () => Promise<MessageQueue>) {
  if (busy.value) return
  const id = props.sessionId
  busy.value = true
  error.value = ''
  try {
    const queue = await operation()
    if (id === props.sessionId) {
      emit('updated', queue)
      editing.value = null
      confirming.value = null
    }
  } catch (e) {
    if (id === props.sessionId) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
function edit(message: QueuedMessage) {
  editing.value = message.id
  text.value = message.message.text
}
function save(message: QueuedMessage) {
  // Keep the original attachments; editing text never strips file content from the queued request.
  return act(() =>
    api.editQueuedMessage(props.sessionId, message.id, { ...message.message, text: text.value }),
  )
}
function label(message: QueuedMessage) {
  return message.state === 'uncertain'
    ? 'Delivery uncertain'
    : message.state === 'sending'
      ? 'In progress'
      : props.queue.paused
        ? 'Paused'
        : 'Queued'
}
</script>

<template>
  <section v-if="visible.length" class="message-queue" aria-label="Message queue" :aria-busy="busy">
    <div class="message-queue__heading">
      <span role="status" aria-live="polite"
        >{{ queue.paused ? 'Queue paused' : 'Message queue' }} · {{ visible.length }}</span
      >
      <span class="message-queue__actions">
        <IuButton
          v-if="nextQueued"
          size="sm"
          variant="ghost"
          :disabled="busy || hasUncertain"
          title="Send the next message now"
          @click="act(() => api.sendNow(sessionId))"
          >Send now</IuButton
        >
        <IuButton
          v-if="queue.paused"
          size="sm"
          variant="ghost"
          :disabled="busy || hasUncertain"
          @click="act(() => api.resumeQueue(sessionId))"
          >Resume queue</IuButton
        >
      </span>
    </div>
    <p v-if="queue.paused" class="message-queue__hint">
      {{
        nextQueued
          ? 'Messages stay here until you resume. Send now sends the next one.'
          : 'Messages stay here until you resume the queue.'
      }}
    </p>
    <IuCallout v-if="error" intent="danger" variant="subtle" live>{{ error }}</IuCallout>
    <ol class="message-queue__list">
      <li
        v-for="message in visible"
        :key="message.id"
        class="message-queue__item"
        :data-message-id="message.id"
      >
        <span class="message-queue__state">{{ label(message) }}</span>
        <template v-if="editing === message.id">
          <IuTextarea v-model="text" label="Edit queued message" :disabled="busy" :rows="2" />
          <div class="message-queue__actions">
            <IuButton size="sm" :disabled="busy || !text.trim()" @click="save(message)"
              >Save message</IuButton
            >
            <IuButton size="sm" variant="ghost" :disabled="busy" @click="editing = null"
              >Keep original</IuButton
            >
          </div>
        </template>
        <p v-else class="message-queue__text">{{ message.message.text }}</p>
        <ul
          v-if="message.message.attachments?.length"
          class="message-queue__files"
          aria-label="Attached files"
        >
          <li v-for="(file, index) in message.message.attachments" :key="index">{{ file.name }}</li>
        </ul>
        <div
          v-if="message.state === 'queued' && editing !== message.id"
          class="message-queue__actions"
        >
          <IuButton size="sm" variant="ghost" :disabled="busy" @click="edit(message)"
            >Edit</IuButton
          >
          <IuButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            @click="act(() => api.cancelQueuedMessage(sessionId, message.id))"
            >Cancel message</IuButton
          >
        </div>
        <template v-if="message.state === 'uncertain'">
          <p class="message-queue__hint">
            The agent may have received this message. Check the conversation before retrying; a
            retry may repeat its actions. Dismissing only removes this queue record.
          </p>
          <div class="message-queue__actions">
            <IuButton
              size="sm"
              variant="ghost"
              :disabled="busy"
              @click="act(() => api.cancelQueuedMessage(sessionId, message.id))"
              >Dismiss from queue</IuButton
            >
            <IuButton
              v-if="confirming !== message.id"
              size="sm"
              variant="ghost"
              :disabled="busy"
              @click="confirming = message.id"
              >Retry message…</IuButton
            >
            <template v-else>
              <IuButton
                size="sm"
                :disabled="busy"
                @click="act(() => api.retryQueuedMessage(sessionId, message.id))"
                >Queue retry</IuButton
              >
              <IuButton size="sm" variant="ghost" :disabled="busy" @click="confirming = null"
                >Keep paused</IuButton
              >
            </template>
          </div>
        </template>
      </li>
    </ol>
  </section>
</template>

<style>
.message-queue {
  margin: 0;
  padding: 0 2px;
  background: transparent;
}
.message-queue__heading,
.message-queue__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.message-queue__heading {
  justify-content: space-between;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-regular);
}
.message-queue__hint,
.message-queue__state,
.message-queue__files {
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
}
.message-queue__hint {
  margin: 6px 0;
}
.message-queue__list {
  list-style: none;
  padding: 0;
  margin: 8px 0 0;
  max-height: 32vh;
  overflow-y: auto;
}
.message-queue__item + .message-queue__item {
  margin-top: 8px;
}
.message-queue__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 4px 0;
  font-size: var(--iu-font-size-13);
}
.message-queue__files {
  padding-left: 18px;
}
</style>
