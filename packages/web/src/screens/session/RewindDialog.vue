<script setup lang="ts">
// Rewind to a checkpoint: pick what happens (branch, rewind this session, restore files, fork the conversation), see
// which files would change, confirm. The server does the work (restoreCheckpoint, forkSession); this collects the
// choice and reports the outcome. Destructive modes say so and are never the default.
import { computed, ref, watch } from 'vue'
import type { Checkpoint, CheckpointDiff, RestoreCheckpointResult, Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuRadio } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'

type Mode = 'branch' | 'rewind' | 'files' | 'fork'

const props = defineProps<{
  sessionId: string
  checkpoint: Checkpoint | null
  /** The user message the checkpoint precedes, for the heading. */
  messageText: string
  /** The harness can fork a stored session at a message. */
  forkAt: boolean
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{
  /** A new session exists (branch, fork or conversation rewind): go to it. */
  forked: [session: Session]
  /** Files were restored in this session; `undoCheckpointId` undoes it. */
  restored: [result: RestoreCheckpointResult]
}>()

const api = useApi()
const mode = ref<Mode>('branch')
const diff = ref<CheckpointDiff | null>(null)
const diffError = ref<string | null>(null)
const working = ref(false)
const error = ref<string | null>(null)

const hasFiles = computed(() => props.checkpoint?.snapshot === 'ok')
const first = computed(() => (props.checkpoint?.turn ?? 0) <= 1)
// What the harness and the checkpoint allow. The first message has nothing before it to cut at.
const canCut = computed(() => props.forkAt && !first.value)
const available = computed<Record<Mode, boolean>>(() => ({
  branch: canCut.value,
  rewind: canCut.value,
  files: hasFiles.value,
  fork: canCut.value,
}))
const restoresFiles = computed(
  () => (mode.value === 'files' || mode.value === 'rewind') && hasFiles.value,
)

watch(
  open,
  isOpen => {
    if (!isOpen) return
    error.value = null
    diff.value = null
    diffError.value = null
    mode.value = available.value.branch ? 'branch' : hasFiles.value ? 'files' : 'fork'
    const cp = props.checkpoint
    if (cp && hasFiles.value)
      api
        .checkpointDiff(props.sessionId, cp.id, 'current')
        .then(d => (diff.value = d))
        .catch(e => (diffError.value = e instanceof Error ? e.message : String(e)))
  },
  { immediate: true },
)

const SHOWN = 8
const verb = { added: 'recreated', modified: 'reverted', removed: 'deleted' } as const
const shownFiles = computed(() => diff.value?.files.slice(0, SHOWN) ?? [])
const moreFiles = computed(() => (diff.value ? diff.value.files.length - SHOWN : 0))

const labels: Record<Mode, { title: string; body: string; action: string }> = {
  branch: {
    title: 'Branch from here',
    body: 'A new session in its own worktree, with the conversation and files as they were. This session is not touched.',
    action: 'Branch',
  },
  rewind: {
    title: 'Rewind this session',
    body: 'Continue in a new session cut at this message and put the project files back. This session is archived, not deleted.',
    action: 'Rewind',
  },
  files: {
    title: 'Restore files only',
    body: 'Put the project files back as they were, and keep the conversation as it is. The current files are saved first, so you can undo.',
    action: 'Restore files',
  },
  fork: {
    title: 'Fork the conversation only',
    body: 'A new session cut at this message, leaving the files as they are now.',
    action: 'Fork',
  },
}

async function confirm() {
  const cp = props.checkpoint
  if (!cp || working.value || !available.value[mode.value]) return
  working.value = true
  error.value = null
  try {
    if (mode.value === 'branch') {
      const session = await api.forkSession(props.sessionId, {
        atMessageId: cp.messageId!,
        ...(hasFiles.value ? { worktree: true, restoreFiles: true } : {}),
      })
      open.value = false
      emit('forked', session)
    } else if (mode.value === 'fork') {
      const session = await api.forkSession(props.sessionId, { atMessageId: cp.messageId! })
      open.value = false
      emit('forked', session)
    } else {
      const result = await api.restoreCheckpoint(props.sessionId, cp.id, {
        files: hasFiles.value,
        conversation: mode.value === 'rewind',
      })
      open.value = false
      if (mode.value === 'rewind') emit('forked', result.session)
      emit('restored', result)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    working.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" size="md">
    <template #header>
      <h2 class="rewind__title">Rewind to before this message</h2>
    </template>
    <form class="rewind" @submit.prevent="confirm">
      <blockquote class="rewind__message">{{ messageText }}</blockquote>
      <fieldset class="rewind__modes">
        <legend class="rewind__legend">What should happen?</legend>
        <div
          v-for="m in ['branch', 'rewind', 'files', 'fork'] as Mode[]"
          :key="m"
          class="rewind__mode"
        >
          <IuRadio v-model="mode" name="rewind-mode" :value="m" :disabled="!available[m]">
            <span class="rewind__mode-title">{{ labels[m].title }}</span>
          </IuRadio>
          <p class="rewind__mode-body">
            {{ labels[m].body }}
            <template v-if="!available[m]">
              <em v-if="m === 'files'"> Not available: this checkpoint has no saved files.</em>
              <em v-else-if="!forkAt">
                Not available: this harness cannot cut a conversation at a message.</em
              >
              <em v-else> Not available: the first message has nothing before it.</em>
            </template>
          </p>
        </div>
      </fieldset>
      <section v-if="restoresFiles" class="rewind__files" aria-live="polite">
        <h3 class="rewind__files-title">In the project folder</h3>
        <p v-if="diffError" class="rewind__muted">Could not compare the files: {{ diffError }}</p>
        <p v-else-if="!diff" class="rewind__muted">Comparing files…</p>
        <p v-else-if="!diff.files.length" class="rewind__muted">
          Nothing would change: the files already match.
        </p>
        <template v-else>
          <ul class="rewind__list">
            <li v-for="f in shownFiles" :key="f.path">
              <code class="rewind__path">{{ f.path }}</code>
              <span class="rewind__verb">{{ verb[f.status] }}</span>
            </li>
          </ul>
          <p v-if="moreFiles > 0 || diff.truncated" class="rewind__muted">
            and {{ moreFiles > 0 ? moreFiles : 'more' }}{{ diff.truncated ? '+' : '' }} more
          </p>
        </template>
      </section>
      <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    </form>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="working" @click="open = false"
        >Cancel</IuButton
      >
      <IuButton
        :variant="mode === 'rewind' || mode === 'files' ? 'danger' : 'primary'"
        size="sm"
        :loading="working"
        :disabled="!available[mode]"
        @click="confirm"
        >{{ labels[mode].action }}</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.rewind__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.rewind {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rewind__message {
  margin: 0;
  padding: 6px 10px;
  border-left: 2px solid var(--iu-border);
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.rewind__modes {
  margin: 0;
  padding: 0;
  border: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rewind__legend {
  padding: 0;
  margin-bottom: 6px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.rewind__mode-title {
  font-weight: var(--iu-font-weight-medium);
}
.rewind__mode-body {
  margin: 2px 0 0 26px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.rewind__files {
  padding: 10px 12px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
}
.rewind__files-title {
  margin: 0 0 6px;
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text-2);
}
.rewind__list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.rewind__list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: var(--iu-font-size-12);
}
.rewind__path {
  font-family: var(--iu-font-mono);
  overflow-wrap: anywhere;
}
.rewind__verb,
.rewind__muted {
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
  flex: none;
}
.rewind__muted {
  margin: 0;
}
</style>
