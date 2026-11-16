<script setup lang="ts">
import { computed } from 'vue'
import type { ChatMessage } from '@/components/Chat/types'
import IuAvatar from '@/components/Avatar/Avatar.vue'
import IuButton from '@/components/Button/Button.vue'
import IuCallout from '@/components/Callout/Callout.vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuMarkdown from '@/components/Markdown/Markdown.vue'
import IuFlock from '@/components/Spinner/Flock.vue'
import IuApproval from '@/components/Chat/Approval.vue'
import IuAttachment from '@/components/Chat/Attachment.vue'
import IuThinking from '@/components/Chat/Thinking.vue'
import IuToolGroup from '@/components/Chat/ToolGroup.vue'
import { useCopy } from '@/composables/useCopy'

const props = withDefaults(
  defineProps<{
    message: ChatMessage
    /** false = continuation of the same author's previous turn: no avatar/name line */
    showHeader?: boolean
    actions?: boolean
    /** names to highlight as @mentions in assistant prose (see IuMarkdown) */
    mentions?: string[]
    /** the current user's name, so mentions of them get the "you" tint */
    self?: string
    /** render text parts as markdown; undefined = automatic (assistant turns only) */
    markdown?: boolean
    /** show Regenerate on assistant turns (Copy stays); off where a turn can't be re-run */
    regenerate?: boolean
    /** subagents out while this turn is working: dots that peel off the working flock */
    agents?: number
  }>(),
  {
    showHeader: true,
    actions: true,
    mentions: () => [],
    markdown: undefined,
    regenerate: true,
    agents: 0,
  },
)

const emit = defineEmits<{
  approve: [approvalId: string]
  deny: [approvalId: string]
  always: [approvalId: string]
  retry: []
  copy: []
}>()

const isSystem = computed(() => props.message.role === 'system')
const isAssistant = computed(() => props.message.role === 'assistant')
// by default only assistant prose is markdown, so a chat user's `*` doesn't vanish; hosts whose users write
// markdown on purpose (forum posts) opt in
const plainText = computed(() =>
  props.markdown === undefined ? !isAssistant.value : !props.markdown,
)

const streaming = computed(() => !!props.message.streaming)
const lastIndex = computed(() => props.message.parts.length - 1)

const showHeaderLine = computed(() => props.showHeader && !isSystem.value)
const showActions = computed(
  () => props.actions && !streaming.value && props.message.role !== 'system',
)

const at = computed(() => new Date(props.message.at))
const validTime = computed(() => !Number.isNaN(at.value.getTime()))
const hhmm = computed(() => {
  if (!validTime.value) return ''
  const d = at.value
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})
const fullTime = computed(() =>
  validTime.value
    ? at.value.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : '',
)

// all text parts, so a turn with tools or thinking still copies its answer
const copyText = computed(() =>
  props.message.parts
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('\n\n'),
)

const { copied, copy: writeClipboard } = useCopy()
async function onCopy() {
  if (await writeClipboard(copyText.value)) emit('copy')
}
</script>

<template>
  <article
    :class="[
      'iu-message',
      `iu-message--${message.role}`,
      { 'has-header': showHeaderLine, 'is-streaming': streaming },
    ]"
    :data-role="message.role"
    :aria-label="`${message.author.name}, ${hhmm}`"
    :aria-busy="streaming || undefined"
  >
    <IuAvatar
      v-if="showHeaderLine"
      class="iu-message__avatar"
      :name="message.author.name"
      :kind="message.author.kind"
      :id="message.author.id"
      :size="24"
    />

    <div v-if="showHeaderLine" class="iu-message__head">
      <span class="iu-message__name" :data-kind="message.author.kind">{{
        message.author.name
      }}</span>
      <time class="iu-message__time" :datetime="message.at" :title="fullTime">{{ hhmm }}</time>
    </div>

    <!-- in the header line when there is one; continuation turns float it in the
         gap above the row (Slack-style) so every turn can be copied/regenerated -->
    <div
      v-if="showActions"
      class="iu-message__actions"
      :class="{ 'iu-message__actions--float': !showHeaderLine }"
    >
      <IuButton
        v-if="copyText"
        class="iu-message__copy"
        variant="ghost"
        size="sm"
        icon-only
        aria-label="Copy message"
        @click="onCopy"
      >
        <template #icon><IuIcon :name="copied ? 'check' : 'copy'" :size="14" /></template>
      </IuButton>
      <IuButton
        v-if="isAssistant && regenerate"
        class="iu-message__regenerate"
        variant="ghost"
        size="sm"
        icon-only
        aria-label="Regenerate"
        @click="emit('retry')"
      >
        <template #icon><IuIcon name="retry" :size="14" /></template>
      </IuButton>
    </div>

    <div class="iu-message__body">
      <template v-for="(part, i) in message.parts" :key="i">
        <p v-if="part.type === 'text' && plainText" class="iu-message__plain">{{ part.text }}</p>
        <IuMarkdown
          v-else-if="part.type === 'text'"
          :source="part.text"
          :streaming="streaming && i === lastIndex"
          :mentions="mentions"
          :self="self"
        />
        <IuThinking
          v-else-if="part.type === 'thinking'"
          :text="part.text"
          :duration-ms="part.durationMs"
          :streaming="streaming && i === lastIndex"
        />
        <IuToolGroup v-else-if="part.type === 'tools'" :steps="part.steps" />
        <IuApproval
          v-else-if="part.type === 'approval'"
          :request="part.approval"
          @approve="emit('approve', part.approval.id)"
          @deny="emit('deny', part.approval.id)"
          @always="emit('always', part.approval.id)"
        />
        <div v-else-if="part.type === 'attachments'" class="iu-message__files">
          <IuAttachment v-for="file in part.files" :key="file.id" :file="file" />
        </div>
      </template>

      <!-- host content that belongs to this turn (cards, frames), aligned with the prose -->
      <slot />

      <div v-if="streaming && message.parts.length === 0" class="iu-message__working" role="status">
        <IuFlock :agents="agents" />
        <span>Working…</span>
      </div>

      <IuCallout v-if="message.error" intent="danger" variant="subtle" :title="message.error">
        <template #actions>
          <IuButton variant="secondary" size="sm" @click="emit('retry')">Retry</IuButton>
        </template>
      </IuCallout>
    </div>
  </article>
</template>

<style>
/* Grid: a fixed 24px avatar column keeps text aligned whether or not the header
   is shown. The header and body share the second column, so prose, tool rows and
   thinking rows all start on the same edge. */
.iu-message {
  position: relative;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  column-gap: 12px;
  min-width: 0;
  color: var(--iu-text);
  font-family: var(--iu-font-sans);
}

.iu-message__avatar {
  grid-column: 1;
  grid-row: 1;
}

.iu-message__head {
  grid-column: 2;
  grid-row: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 24px;
  min-width: 0;
}

.iu-message__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text);
}

.iu-message__name[data-kind='agent'] {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
  font-weight: var(--iu-font-weight-medium);
}

.iu-message__time {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  white-space: nowrap;
}

/* hidden with opacity, not display, so revealing them never moves the thread.
   Absolutely placed at the header line's right end, so they never take width from it */
.iu-message__actions {
  position: absolute;
  top: 0;
  right: 0;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--iu-dur-fast) linear;
}

/* continuation turns have no header line: a small raised toolbar in the gap above */
.iu-message__actions--float {
  top: -14px;
  height: 28px;
  padding: 0 2px;
  background: var(--iu-raised);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  z-index: 1;
}

.iu-message:hover .iu-message__actions,
.iu-message:focus-within .iu-message__actions {
  opacity: 1;
}

@media (hover: none) {
  .iu-message__actions {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .iu-message__actions {
    transition: none;
  }
}

.iu-message__body {
  grid-column: 2;
  grid-row: 2;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

.iu-message:not(.has-header) .iu-message__body {
  grid-row: 1;
}

.iu-message.has-header .iu-message__body {
  margin-top: 4px;
}

/* user turns: a tinted block pulled 12px left so its text lands on the assistant text edge */
.iu-message--user .iu-message__body {
  margin-left: -12px;
  margin-right: -12px;
  padding: 10px 12px;
  background: var(--iu-surface);
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-lg);
}

.iu-message__plain {
  margin: 0;
  font-size: var(--iu-font-size-14);
  line-height: var(--iu-leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: var(--iu-text);
}

.iu-message__files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.iu-message__working {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 20px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}

/* system notes: one centred line, no avatar or header */
.iu-message--system {
  display: block;
  text-align: center;
}

.iu-message--system .iu-message__body {
  align-items: center;
}

.iu-message--system .iu-message__plain {
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-normal);
  color: var(--iu-text-muted);
}
</style>
