<script setup lang="ts">
// Go back to a checkpoint, in the message box's place (SessionComposer's `replacement` slot), like an agent question.
// A timeline of the session's turns shows where you are going back to and what would be left behind; four cards say
// what happens (branch, rewind, restore files, fork); a one-line result says exactly what you get; the files that
// would change sit under a disclosure. Keys: 1–4 choose, Enter confirms, Esc cancels. The server does the work
// (restoreCheckpoint, forkSession). Destructive modes say so and are never the default. Closing puts the message box back.
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import type { Checkpoint, CheckpointDiff, RestoreCheckpointResult, Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuIcon } from '@/components/Icon'
import type { IconName } from '@/components/Icon'

type Mode = 'branch' | 'rewind' | 'files' | 'fork'

const props = defineProps<{
  sessionId: string
  checkpoint: Checkpoint | null
  /** All of the session's checkpoints, for the timeline. */
  checkpoints: Checkpoint[]
  /** The user message the checkpoint precedes, for the heading. */
  messageText: string
  /** The harness can fork a stored session at a message. */
  forkAt: boolean
}>()

const emit = defineEmits<{
  /** Esc, Cancel, or done: the message box comes back. */
  close: []
  /** A new session exists (branch, fork or conversation rewind): go to it. */
  forked: [session: Session]
  /** The restore finished; `undoCheckpointId` undoes a files restore. */
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
// The first message has nothing before it to cut the conversation at.
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

function init() {
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
}
const root = useTemplateRef<HTMLElement>('root')
// The reader asked for this card, so it takes focus (unlike a prompt that appears on its own): the keys work at once.
onMounted(() => {
  init()
  void nextTick(() => root.value?.focus())
})
watch(() => props.checkpoint?.id, init)

// ── the timeline: one dot per turn; the chosen turn is the point you go back to ──
const turns = computed(() =>
  props.checkpoints.filter(c => c.kind === 'turn').sort((a, b) => a.turn - b.turn),
)
const at = computed(() => props.checkpoint?.turn ?? 0)
const kept = computed(() => Math.max(0, at.value - 1))
/** Whether the conversation after the chosen point stays with the result of this mode. */
const cutsConversation = computed(() => mode.value !== 'files')
function dotState(turn: number): 'kept' | 'chosen' | 'later' {
  if (turn < at.value) return 'kept'
  if (turn === at.value) return 'chosen'
  return 'later'
}

const turnsWord = (n: number) => `${n} ${n === 1 ? 'turn' : 'turns'}`
const outcome = computed(() => {
  const k = turnsWord(kept.value)
  switch (mode.value) {
    case 'branch':
      return `A new session with ${k}${hasFiles.value ? ', in its own worktree with the files from then' : ''}. This session keeps all ${turnsWord(turns.value.length)}.`
    case 'rewind':
      return `Continue in a new session with ${k}${hasFiles.value ? ' and the project files put back' : ''}. This session is archived, not deleted.`
    case 'files':
      return `The project files go back to before turn ${at.value}. The conversation keeps all ${turnsWord(turns.value.length)}, and the current files are saved first so you can undo.`
    default:
      return `A new session with ${k}. The files stay as they are now.`
  }
})

const cards: { mode: Mode; icon: IconName; title: string; blurb: string; action: string }[] = [
  {
    mode: 'branch',
    icon: 'gitBranch',
    title: 'Branch',
    blurb: 'Try another way, keep this one',
    action: 'Branch',
  },
  {
    mode: 'rewind',
    icon: 'history',
    title: 'Rewind',
    blurb: 'Undo the turns after this point',
    action: 'Rewind',
  },
  {
    mode: 'files',
    icon: 'file',
    title: 'Files only',
    blurb: 'Keep the chat, put the files back',
    action: 'Restore files',
  },
  {
    mode: 'fork',
    icon: 'message',
    title: 'Fork chat',
    blurb: 'Cut the chat here, leave files alone',
    action: 'Fork',
  },
]
const card = computed(() => cards.find(c => c.mode === mode.value)!)
const whyNot = (m: Mode) =>
  m === 'files'
    ? 'This checkpoint has no saved files.'
    : !props.forkAt
      ? 'This harness cannot cut a conversation at a message.'
      : 'The first message has nothing before it.'

const SHOWN = 8
const verb = { added: 'recreated', modified: 'reverted', removed: 'deleted' } as const
const shownFiles = computed(() => diff.value?.files.slice(0, SHOWN) ?? [])
const moreFiles = computed(() => (diff.value ? diff.value.files.length - SHOWN : 0))

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement
  if (t.closest('summary,button,details')) {
    if (e.key === 'Escape') emit('close')
    return
  }
  if (e.key === 'Escape') return void emit('close')
  if (e.key === 'Enter') {
    e.preventDefault()
    return void confirm()
  }
  const n = Number(e.key)
  const c = cards[n - 1]
  if (n >= 1 && n <= cards.length && c && available.value[c.mode]) mode.value = c.mode
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
      emit('close')
      emit('forked', session)
    } else if (mode.value === 'fork') {
      const session = await api.forkSession(props.sessionId, { atMessageId: cp.messageId! })
      emit('close')
      emit('forked', session)
    } else {
      const result = await api.restoreCheckpoint(props.sessionId, cp.id, {
        files: hasFiles.value,
        conversation: mode.value === 'rewind',
      })
      emit('close')
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
  <section
    ref="root"
    class="rewind"
    tabindex="-1"
    role="group"
    :aria-label="`Go back to before turn ${at}`"
    @keydown="onKey"
  >
    <header class="rewind__top">
      <IuIcon name="history" :size="16" class="rewind__top-icon" />
      <h2 class="rewind__title" :title="messageText">Go back to before turn {{ at }}</h2>
      <span class="rewind__hint">1–4 choose · Enter confirms · Esc cancels</span>
    </header>
    <div class="rewind__body">
      <figure class="rewind__timeline" :aria-label="`Turn ${at} of ${turns.length}`">
        <ol class="rewind__track">
          <li
            v-for="t in turns"
            :key="t.id"
            class="rewind__stop"
            :class="[
              `rewind__stop--${dotState(t.turn)}`,
              { 'rewind__stop--dim': dotState(t.turn) !== 'kept' && cutsConversation },
            ]"
            :aria-current="t.turn === at ? 'step' : undefined"
          >
            <span class="rewind__dot" />
            <span class="rewind__stop-label">{{ t.turn }}</span>
          </li>
        </ol>
      </figure>

      <div class="rewind__cards" role="radiogroup" aria-label="What should happen?">
        <label
          v-for="c in cards"
          :key="c.mode"
          class="rewind__card"
          :class="{
            'rewind__card--on': mode === c.mode,
            'rewind__card--off': !available[c.mode],
          }"
          :title="available[c.mode] ? c.blurb : whyNot(c.mode)"
        >
          <input
            v-model="mode"
            class="rewind__radio"
            type="radio"
            name="rewind-mode"
            :value="c.mode"
            :disabled="!available[c.mode]"
          />
          <IuIcon :name="c.icon" :size="16" class="rewind__card-icon" />
          <span class="rewind__card-title">{{ c.title }}</span>
        </label>
      </div>

      <details v-if="restoresFiles" class="rewind__files">
        <summary>
          Files that change<template v-if="diff">
            ({{ diff.files.length }}{{ diff.truncated ? '+' : '' }})</template
          >
        </summary>
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
          <p v-if="moreFiles > 0" class="rewind__muted">and {{ moreFiles }} more</p>
        </template>
      </details>
      <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    </div>
    <footer class="rewind__foot">
      <p class="rewind__outcome" aria-live="polite">{{ outcome }}</p>
      <IuButton variant="ghost" size="sm" :disabled="working" @click="emit('close')"
        >Cancel</IuButton
      >
      <IuButton
        :variant="mode === 'rewind' || mode === 'files' ? 'danger' : 'primary'"
        size="sm"
        :loading="working"
        :disabled="!available[mode]"
        @click="confirm"
        >{{ card.action }}</IuButton
      >
    </footer>
  </section>
</template>

<style>
/* same card chrome as an agent question (PermissionPrompt) */
.rewind {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-inline-size: 0;
  padding: 10px 12px;
  background: var(--iu-surface);
  border: 1px solid var(--iu-info-border);
  border-inline-start: 3px solid var(--iu-info);
  border-radius: var(--iu-radius-lg);
}
.rewind:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.rewind__top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rewind__top-icon {
  color: var(--iu-text-2);
  flex: none;
}
.rewind__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
  white-space: nowrap;
}
.rewind__hint {
  white-space: nowrap;
  margin-inline-start: auto;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.rewind__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.rewind__foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.rewind__foot > :not(.rewind__outcome) {
  flex: none;
}
.rewind__foot .rewind__outcome {
  margin-inline-end: auto;
  min-inline-size: 0;
  flex: 1 1 0;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-12);
}
.rewind__message {
  margin: 0;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rewind__timeline {
  margin: 0;
}
.rewind__track {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  align-items: flex-start;
  overflow-x: auto;
}
.rewind__stop {
  position: relative;
  flex: 1 1 0;
  min-inline-size: 28px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}
/* the line between dots; the first dot has none */
.rewind__stop + .rewind__stop::before {
  content: '';
  position: absolute;
  top: 4px;
  inset-inline-end: 50%;
  inline-size: 100%;
  block-size: 2px;
  background: var(--iu-border-strong);
}
.rewind__stop--dim + .rewind__stop--dim::before,
.rewind__stop--chosen::before {
  background: var(--iu-border);
}
.rewind__dot {
  position: relative;
  inline-size: 10px;
  block-size: 10px;
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid var(--iu-text-2);
  background: var(--iu-text-2);
}
.rewind__stop--chosen .rewind__dot {
  border-color: var(--iu-accent);
  background: var(--iu-bg, var(--iu-hover));
  box-shadow: 0 0 0 3px var(--iu-accent-wash);
}
.rewind__stop--dim:not(.rewind__stop--chosen) .rewind__dot {
  border-color: var(--iu-border-strong);
  background: transparent;
}
.rewind__stop-label {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.rewind__caption {
  margin-top: 6px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.rewind__cards {
  display: flex;
  gap: 6px;
}
.rewind__card {
  position: relative;
  flex: 1 1 0;
  min-inline-size: 0;
  display: grid;
  grid-template-columns: 16px auto;
  justify-content: center;
  column-gap: 6px;
  align-items: center;
  padding: 5px 8px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-lg);
  cursor: pointer;
}
.rewind__card:hover {
  background: var(--iu-hover);
}
.rewind__card--on {
  border-color: var(--iu-accent);
  background: var(--iu-accent-wash);
}
.rewind__card:has(.rewind__radio:focus-visible) {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.rewind__card--off {
  opacity: 0.55;
  cursor: not-allowed;
}
.rewind__radio {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
.rewind__card-icon {
  color: var(--iu-text-2);
}
.rewind__card-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-semibold);
}
.rewind__card-blurb {
  grid-column: 2;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.rewind__outcome {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
}
.rewind__files {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.rewind__files summary {
  cursor: pointer;
  font-weight: var(--iu-font-weight-semibold);
}
.rewind__list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 64px;
  overflow-y: auto;
}
.rewind__list li {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.rewind__path {
  font-family: var(--iu-font-mono);
  overflow-wrap: anywhere;
}
.rewind__verb,
.rewind__muted {
  color: var(--iu-text-muted);
  flex: none;
}
.rewind__muted {
  margin: 6px 0 0;
}
@media (max-width: 700px) {
  .rewind__hint {
    display: none;
  }
}
</style>
