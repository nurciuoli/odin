<script setup lang="ts">
// The session's header: title and state on the left, an actions menu on the right.
// Model and permission mode live beside the composer; workspace information lives in Details.
// Every action calls the API itself and hands the
// updated record up.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Session, SessionDetail } from '@odin/shared/api'
import type { PermissionRequest } from '@odin/shared/harness'
import { useApi } from '@/api'
import { registerCommand } from '@/app/commands'
import { getDesktop, openPath, OPEN_TARGETS, type OpenTarget } from '@/app/desktop'
import { SESSIONS_KEY } from '@/app/sessions'
import { IuHeader } from '@/components/AppShell'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuDialog } from '@/components/Modal'
import { useToast } from '@/components/Toast'
import { statusIntent } from '@/styles/status'
import { needYouCount, SESSION_DISPLAY } from '@/screens/shared/format'
import { useQuickAnswer } from '@/screens/shared/useQuickAnswer'
import SaveToLibraryModal from '@/screens/library/SaveToLibraryModal.vue'
import ForkModal from './ForkModal.vue'
import SessionStatusBand from './SessionStatusBand.vue'

const props = defineProps<{
  session: SessionDetail
  /** The turn is over but subagents or background commands still run: the chip says Running, not Idle. */
  working?: boolean
}>()

const emit = defineEmits<{
  updated: [session: Session]
  forked: [session: Session]
  deleted: []
}>()

const api = useApi()
const { toast } = useToast()

const display = computed(
  () =>
    SESSION_DISPLAY[
      props.working && props.session.state === 'idle' ? 'running' : props.session.state
    ],
)
// running, needs you and failed say their state in the band under the title; the chip is for idle and done
const hasBand = computed(() => ['running', 'awaiting', 'failed'].includes(display.value.status))
const isFinal = computed(() => props.session.state === 'ended' || props.session.state === 'failed')
const worktree = computed(() =>
  props.session.workspace.kind === 'worktree' ? props.session.workspace : null,
)

function fail(title: string, e: unknown) {
  toast({ title, description: e instanceof Error ? e.message : String(e), intent: 'danger' })
}

async function patch(req: Parameters<typeof api.updateSession>[1], what: string) {
  try {
    emit('updated', await api.updateSession(props.session.id, req))
  } catch (e) {
    fail(`Couldn't ${what}`, e)
  }
}

// ── rename ──
const renaming = ref(false)
const draft = ref('')
const titleField = ref<{ $el: HTMLElement } | null>(null)
const actionsButton = ref<{ $el: HTMLElement } | null>(null)

async function startRename() {
  draft.value = props.session.title
  renaming.value = true
  await nextTick()
  const input = titleField.value?.$el.querySelector('input')
  input?.focus()
  input?.select()
}
async function stopRename(save: boolean) {
  // Enter/Escape unmount the field, which can also fire focusout: only the first one counts
  if (!renaming.value) return
  const next = draft.value.trim()
  renaming.value = false
  if (save && next && next !== props.session.title) await patch({ title: next }, 'rename')
  await nextTick()
  actionsButton.value?.$el.focus()
}
function onRenameKey(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    void stopRename(true)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    void stopRename(false)
  }
}

// ── actions ──
const forkOpen = ref(false)
const saveOpen = ref(false)
const deleteOpen = ref(false)
const deleting = ref(false)
const deleteError = ref<string | null>(null)

const desktop = getDesktop()

const menuItems = computed<MenuItem[]>(() => {
  const items: MenuItem[] = [
    { id: 'rename', label: 'Rename…', icon: 'pencil' },
    { id: 'pin', type: 'check', label: 'Pinned', checked: props.session.pinned },
  ]
  items.push(
    { type: 'separator' },
    { id: 'fork', label: 'Fork…', icon: 'gitBranch' },
    { id: 'save', label: 'Save to library…', icon: 'addLayer' },
    { id: 'end', label: 'End session', icon: 'stop', disabled: isFinal.value },
    {
      id: 'archive',
      label: props.session.archived ? 'Unarchive' : 'Archive',
      icon: 'folder',
    },
  )
  if (desktop) {
    items.push({ type: 'separator' })
    for (const t of OPEN_TARGETS)
      items.push({ id: `open:${t.id}`, label: t.label, icon: 'external' })
  }
  items.push({ type: 'separator' })
  items.push({ id: 'delete', label: 'Delete…', icon: 'trash', destructive: true })
  return items
})

async function onAction(id: string) {
  if (id === 'rename') void startRename()
  else if (id === 'pin')
    await patch({ pinned: !props.session.pinned }, props.session.pinned ? 'unpin' : 'pin')
  else if (id === 'fork') forkOpen.value = true
  else if (id === 'save') saveOpen.value = true
  else if (id === 'delete') {
    deleteError.value = null
    deleteOpen.value = true
  } else if (id === 'archive')
    await patch(
      { archived: !props.session.archived },
      props.session.archived ? 'unarchive' : 'archive',
    )
  else if (id === 'end') {
    try {
      emit('updated', await api.endSession(props.session.id))
    } catch (e) {
      fail("Couldn't end the session", e)
    }
  } else if (id.startsWith('open:')) {
    const ok = await openPath(props.session.cwd, id.slice(5) as OpenTarget)
    if (!ok) toast({ title: "Couldn't open the folder", intent: 'warning' })
  }
}

// ── other sessions waiting for you ──
// A chip with the count (word + number, warning intent) opens a menu of them: what each waits for, Allow/Deny for a
// tool prompt, Open. Nothing here moves focus on its own; the count is announced politely.
const router = useRouter()
const live = inject(SESSIONS_KEY, null)
const quick = useQuickAnswer()
const othersWaiting = computed(
  () => live?.waiting.value.filter(s => s.id !== props.session.id) ?? [],
)
const prompts = ref<Record<string, PermissionRequest | null>>({})
async function loadPrompt(id: string) {
  try {
    const detail = await api.getSession(id)
    prompts.value = { ...prompts.value, [id]: detail.pending[0] ?? null }
  } catch {
    // the row still says what it waits for, from the record
  }
}
watch(
  () => othersWaiting.value.map(s => `${s.id}:${s.updatedAt}`).join(),
  () => {
    for (const s of othersWaiting.value) void loadPrompt(s.id)
  },
  { immediate: true },
)
function waitsFor(s: Session): string {
  const p = prompts.value[s.id]
  if (p?.kind === 'tool') return p.title ?? `Wants to use ${p.toolName}`
  if (p?.kind === 'plan') return 'Has a plan for you to review'
  if (p?.kind === 'question' || s.waitingFor === 'question') return 'Has a question for you'
  return 'Needs your permission'
}
const waitingSummary = computed(() =>
  othersWaiting.value.length ? needYouCount(othersWaiting.value.length, 'other session') : '',
)
// Flat on purpose: a submenu has no room beside its parent in a narrow window and opens over it, where the click
// meant for the row would land on Deny. Each session is an Open row, with Allow/Deny under it for a tool prompt.
const waitingItems = computed<MenuItem[]>(() => [
  { type: 'label', label: waitingSummary.value },
  ...othersWaiting.value.flatMap((s, i): MenuItem[] => {
    const p = prompts.value[s.id]
    const rows: MenuItem[] = [
      ...(i > 0 ? [{ type: 'separator' as const }] : []),
      { id: `open:${s.id}`, label: s.title, description: waitsFor(s), icon: 'bell' },
    ]
    if (p?.kind === 'tool')
      rows.push(
        {
          id: `allow:${s.id}`,
          label: 'Allow once',
          icon: 'check',
          disabled: !!quick.answering.value,
        },
        { id: `deny:${s.id}`, label: 'Deny', icon: 'close', disabled: !!quick.answering.value },
      )
    return rows
  }),
])
async function onWaiting(id: string) {
  const [kind, sessionId] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)]
  if (kind === 'open') {
    void router.push({ name: 'session', params: { id: sessionId } })
    return
  }
  const p = prompts.value[sessionId]
  if (!p || (kind !== 'allow' && kind !== 'deny')) return
  if (await quick.answer(sessionId, p, kind === 'allow')) {
    toast({ title: `${kind === 'allow' ? 'Allowed' : 'Denied'}: ${p.title ?? p.toolName}` })
    void loadPrompt(sessionId)
  }
}

// The palette's `>` list offers Fork while this header is mounted.
let withdraw: (() => void) | null = null
onMounted(() => {
  withdraw = registerCommand({
    id: 'session-fork',
    label: 'Fork this session…',
    icon: 'gitBranch',
    run: () => (forkOpen.value = true),
  })
})
onBeforeUnmount(() => withdraw?.())

async function confirmDelete() {
  deleting.value = true
  deleteError.value = null
  try {
    await api.deleteSession(props.session.id)
    deleteOpen.value = false
    emit('deleted')
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e)
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="session-header">
    <IuHeader>
      <template #breadcrumb>
        <div class="session-header__title-row">
          <IuField
            v-if="renaming"
            ref="titleField"
            v-model="draft"
            class="session-header__rename"
            label="Session title"
            hide-label
            size="sm"
            @keydown="onRenameKey"
            @focusout="stopRename(true)"
          />
          <h1 v-else class="session-header__title" :title="session.title">{{ session.title }}</h1>
          <IuBadge
            v-if="!hasBand"
            class="session-header__status"
            :intent="statusIntent[display.status]"
            :tempo="display.status"
            dot
            >{{ display.label }}</IuBadge
          >
          <IuBadge v-if="session.pinned" variant="tag" size="xs">Pinned</IuBadge>
          <IuBadge v-if="session.archived" variant="tag" size="xs">Archived</IuBadge>
        </div>
      </template>
      <template #actions>
        <IuMenu v-if="othersWaiting.length" :items="waitingItems" fixed @select="onWaiting">
          <template #trigger="{ toggle, open }">
            <IuButton
              class="session-header__waiting"
              variant="ghost"
              size="sm"
              :aria-label="`${waitingSummary}. Show them`"
              aria-haspopup="menu"
              :aria-expanded="open"
              @click="toggle"
            >
              <IuBadge intent="warning"
                >{{ othersWaiting.length
                }}<span class="session-header__waiting-word"> waiting</span></IuBadge
              >
            </IuButton>
          </template>
        </IuMenu>
        <slot name="actions" />
        <IuMenu :items="menuItems" @select="onAction">
          <template #trigger="{ toggle, open }">
            <IuButton
              ref="actionsButton"
              variant="ghost"
              size="sm"
              icon-only
              aria-label="Session settings and actions"
              aria-haspopup="menu"
              :aria-expanded="open"
              @click="toggle"
            >
              <template #icon><IuIcon name="more" :size="16" /></template>
            </IuButton>
          </template>
        </IuMenu>
      </template>
    </IuHeader>

    <SessionStatusBand :session="session" :working="working" />

    <span class="sr-only" role="status" aria-live="polite">{{ waitingSummary }}</span>

    <ForkModal
      v-model:open="forkOpen"
      :session-id="session.id"
      :title="session.title"
      :in-worktree="!!worktree"
      @forked="emit('forked', $event)"
    />

    <SaveToLibraryModal
      v-model:open="saveOpen"
      :session="session"
      @saved="(kind, id) => toast({ title: `Saved to the library as ${kind} “${id}”` })"
    />

    <IuDialog v-model:open="deleteOpen" size="sm">
      <template #header>
        <h2 class="session-header__dialog-title">Delete “{{ session.title }}”?</h2>
      </template>
      <p class="session-header__dialog-body">
        This removes the session and its transcript. Its branch and worktree are kept.
      </p>
      <IuCallout v-if="deleteError" intent="danger" variant="inline" live>{{
        deleteError
      }}</IuCallout>
      <template #footer>
        <IuButton variant="secondary" size="sm" :disabled="deleting" @click="deleteOpen = false"
          >Cancel</IuButton
        >
        <IuButton variant="danger" size="sm" :loading="deleting" @click="confirmDelete"
          >Delete</IuButton
        >
      </template>
    </IuDialog>
  </div>
</template>

<style>
.session-header {
  flex: none;
  display: flex;
  flex-direction: column;
}
.session-header__title-row {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  gap: 8px;
}
.session-header__title {
  margin: 0;
  /* the title takes whatever the chips leave; the chips keep their size */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--iu-font-size-14);
  line-height: var(--iu-leading-snug);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text);
}
.session-header__title-row > :deep(.session-header__status) {
  flex: none;
}
/* Narrow windows: the chip keeps its glyph and count; its accessible name still says "waiting for you". */
@media (max-width: 640px) {
  .session-header__waiting-word {
    display: none;
  }
}
.session-header__rename {
  flex: 1;
  max-width: 480px;
}
.session-header__dialog-title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.session-header__dialog-body {
  margin: 0 0 12px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
</style>
