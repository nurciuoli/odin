<script setup lang="ts">
// One side thread in the session screen's Side view: the side conversation (from the side question on; the fork's
// copy of the parent conversation is left out), kept live through useSessionView, its open prompts, a small composer
// for follow-ups (its own draft, keyed by the side session's id) and the actions: Insert into message (quotes the
// last reply into the parent's draft), Promote (an ordinary session) and Discard (delete, after a confirm).
// Nothing here takes focus on its own; new replies arrive in a list that only follows the bottom while you're there.
import { computed, onBeforeUnmount, ref, toRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { useDrafts } from '@/app/drafts'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuComposer } from '@/components/Composer'
import { IuDialog } from '@/components/Modal'
import { IuErrorState, IuSkeleton } from '@/components/States'
import { useToast } from '@/components/Toast'
import { statusIntent } from '@/styles/status'
import { SESSION_DISPLAY } from '@/screens/shared/format'
import SessionPrompts from './SessionPrompts.vue'
import SessionThread from './SessionThread.vue'
import { buildRows } from './sessionView'
import { lastReply, quote, sideEntries } from './SideThreads'
import { useSessionView } from './useSessionView'

const props = defineProps<{
  sessionId: string
  /** The session the side thread was asked from: Insert into message adds to its draft. */
  parentId: string
  /** Entry ids of the parent's transcript: the fork's copies of them aren't part of the side conversation. */
  parentEntryIds?: ReadonlySet<string>
}>()
const emit = defineEmits<{ promoted: [session: Session]; discarded: [id: string] }>()

const api = useApi()
const router = useRouter()
const drafts = useDrafts()
const { toast } = useToast()
const { view, phase, error, load, setRecord } = useSessionView(toRef(props, 'sessionId'))

const session = computed(() => view.value?.detail ?? null)
const display = computed(() => (session.value ? SESSION_DISPLAY[session.value.state] : null))
const entries = computed(() =>
  session.value ? sideEntries(session.value.transcript, session.value, props.parentEntryIds) : [],
)
const rows = computed(() => {
  const v = view.value
  if (!v) return []
  return buildRows(entries.value, {
    pending: v.detail.pending,
    streaming: v.streaming,
    running: v.detail.live && (v.detail.state === 'running' || v.detail.state === 'waiting'),
    artifacts: v.detail.artifacts,
  })
})
const working = computed(
  () => session.value?.state === 'running' && (view.value?.streaming.length ?? 0) === 0,
)
const reply = computed(() => lastReply(entries.value))

// ── follow-up composer: its own draft ──
const text = ref('')
const sending = ref(false)
const interrupting = ref(false)
let draftKey = ''
let offDraft: () => void = () => {}
watch(
  () => props.sessionId,
  id => {
    offDraft()
    draftKey = id
    text.value = drafts.get(id).text
    offDraft = drafts.subscribe(id, syncDraft)
  },
  { flush: 'sync', immediate: true },
)
watch(text, value => {
  if (value !== drafts.get(draftKey).text) drafts.set(draftKey, { text: value, attachments: [] })
})
function syncDraft() {
  const stored = drafts.get(draftKey).text
  if (stored !== text.value) text.value = stored
}
onBeforeUnmount(() => offDraft())

async function send(payload: { text: string }) {
  const id = props.sessionId
  sending.value = true
  try {
    const s = await api.sendMessage(id, { text: payload.text })
    drafts.clear(id)
    setRecord(s)
  } catch (e) {
    drafts.set(id, { text: payload.text, attachments: [] })
    if (id === props.sessionId) text.value = payload.text
    toast({
      title: "Couldn't send your follow-up",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    sending.value = false
  }
}
async function interrupt() {
  if (interrupting.value) return
  interrupting.value = true
  try {
    await api.interruptSession(props.sessionId)
  } catch (e) {
    toast({
      title: "Couldn't interrupt",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    interrupting.value = false
  }
}

// ── actions ──
const announcement = ref('')
function insert() {
  if (!reply.value) return
  drafts.append(props.parentId, quote(reply.value))
  announcement.value = 'Reply inserted into your message'
}

const promoting = ref(false)
async function promote() {
  if (promoting.value) return
  promoting.value = true
  try {
    const s = await api.updateSession(props.sessionId, { aside: false })
    emit('promoted', s)
    toast({
      title: `“${s.title}” is now a session`,
      intent: 'success',
      action: { label: 'Open', onClick: () => void router.push(`/s/${s.id}`) },
    })
  } catch (e) {
    toast({
      title: "Couldn't promote the side thread",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    promoting.value = false
  }
}

const discardOpen = ref(false)
const discarding = ref(false)
const discardError = ref<string | null>(null)
function askDiscard() {
  discardError.value = null
  discardOpen.value = true
}
async function discard() {
  const id = props.sessionId
  discarding.value = true
  discardError.value = null
  try {
    await api.deleteSession(id)
    drafts.clear(id)
    discardOpen.value = false
    emit('discarded', id)
  } catch (e) {
    discardError.value = e instanceof Error ? e.message : String(e)
  } finally {
    discarding.value = false
  }
}
</script>

<template>
  <section
    class="side-thread"
    :aria-label="session ? `Side thread: ${session.title}` : 'Side thread'"
    :aria-busy="phase === 'loading'"
  >
    <div v-if="phase === 'loading'" class="side-thread__state">
      <IuSkeleton shape="row" :rows="1" />
      <IuSkeleton shape="text" :rows="4" />
    </div>
    <div v-else-if="phase === 'error'" class="side-thread__state">
      <IuErrorState
        title="Couldn’t load this side thread"
        :body="error?.message ?? 'Something went wrong.'"
        :trace-id="`GET /api/sessions/${sessionId} · ${error?.status || 'network'}`"
        @retry="load"
      />
    </div>
    <div v-else-if="phase === 'removed'" class="side-thread__state">
      <p class="side-thread__muted">This side thread was deleted.</p>
    </div>
    <template v-else-if="session && display">
      <header class="side-thread__header">
        <div class="side-thread__heading">
          <h3 class="side-thread__title" :title="session.title">{{ session.title }}</h3>
          <IuBadge :intent="statusIntent[display.status]" :tempo="display.status" dot size="xs">{{
            display.label
          }}</IuBadge>
        </div>
        <div class="side-thread__actions">
          <IuButton
            size="sm"
            variant="secondary"
            :disabled="!reply"
            :title="reply ? 'Quote the last reply in your message' : 'No reply yet'"
            @click="insert"
            >Insert into message</IuButton
          >
          <IuButton size="sm" variant="ghost" :loading="promoting" @click="promote"
            >Promote</IuButton
          >
          <IuButton size="sm" variant="ghost" @click="askDiscard">Discard…</IuButton>
        </div>
      </header>
      <IuCallout v-if="session.error" intent="danger" variant="subtle" class="side-thread__error">{{
        session.error
      }}</IuCallout>
      <div class="side-thread__thread">
        <SessionThread
          label="Side conversation"
          :session-id="session.id"
          :rows="rows"
          :entries="entries"
          :root="session.cwd"
          :working="working"
          :harness="session.harness"
          :task-actions="false"
        />
      </div>
      <div class="side-thread__dock">
        <SessionPrompts
          v-if="session.pending.length"
          :session-id="session.id"
          :pending="session.pending"
        />
        <IuComposer
          v-else
          label="Follow-up message"
          v-model="text"
          :attachable="false"
          :min-rows="1"
          :max-rows="6"
          :disabled="sending || session.state === 'waiting'"
          :stoppable="session.state === 'running'"
          :stopping="interrupting"
          stop-label="Interrupt"
          placeholder="Follow up on the side…"
          @submit="send"
          @stop="interrupt"
        >
          <template #hint><span>↵ send · ⇧↵ newline</span></template>
        </IuComposer>
      </div>
    </template>
    <span class="sr-only" role="status" aria-live="polite">{{ announcement }}</span>

    <IuDialog v-model:open="discardOpen" size="sm">
      <template #header>
        <h2 class="side-thread__dialog-title">Discard this side thread?</h2>
      </template>
      <p class="side-thread__dialog-body">
        This deletes “{{ session?.title }}” and its conversation. The main session is not affected.
      </p>
      <IuCallout v-if="discardError" intent="danger" variant="inline" live>{{
        discardError
      }}</IuCallout>
      <template #footer>
        <IuButton variant="secondary" size="sm" :disabled="discarding" @click="discardOpen = false"
          >Cancel</IuButton
        >
        <IuButton variant="danger" size="sm" :loading="discarding" @click="discard"
          >Discard</IuButton
        >
      </template>
    </IuDialog>
  </section>
</template>

<style>
.side-thread {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.side-thread__state {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
}
.side-thread__muted {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
}
.side-thread__header {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.side-thread__heading {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.side-thread__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-semibold);
}
.side-thread__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.side-thread__error {
  flex: none;
  margin: 8px 14px 0;
}
.side-thread__thread {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.side-thread__dock {
  flex: none;
  padding: 8px 12px 12px;
  max-height: 50%;
  overflow-y: auto;
}
.side-thread__dialog-title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.side-thread__dialog-body {
  margin: 0 0 8px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
</style>
