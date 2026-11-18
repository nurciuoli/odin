<script setup lang="ts">
// The message box. Disabled while a prompt waits for an answer; while a turn runs, a message is still accepted
// and waits in the queue. Interrupt takes the send button's spot until something is typed. Send now (the button
// or /send) stops the turn and delivers immediately. Attachments are
// read here into the API's shape; `/` lists the session's slash commands.
//
// While something waits for the user (`replaced`), the `replacement` slot (the open prompt) takes the message box's
// place. The box stays mounted, hidden, so a draft and its attachments come back untouched; the prompt's own Cancel
// interrupts the turn.
// A prompt that appears on its own never takes focus. Once the user answers from inside it, focus moves on to what
// takes its place (the next prompt, or the message box) instead of dropping to the page.
//
// The draft (text and attachments) lives in the app-wide drafts store under the session id, so switching sessions
// and coming back finds it; a successful send clears it. Restoring never takes focus.
//
// Side questions: ⌥↵, ⌥/ (turns side mode on and puts the caret in the box), or `/btw <question>`
// as the whole message sends the draft as a side thread (a fork with `aside: true`) instead of to this session.
// `aside` hands the new side session to the screen, which shows it in the preview pane; focus stays here.
import { effortChoices, asEffort, pickerExtras } from '@/screens/shared/effort'
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type {
  Attachment,
  ModelInfo,
  MessageQueue,
  UserMessage,
  PermissionMode,
  Session,
  SessionState,
} from '@odin/shared/api'
import { findModel } from '@odin/shared/api'
import type { SlashCommand } from '@odin/shared/harness'
import { useRouter } from 'vue-router'
import { useApi } from '@/api'
import type { Attachment as ChatAttachment, ComposerCommand } from '@/components/Chat'
import { IuComposer, IuComposerSurface } from '@/components/Composer'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuIcon } from '@/components/Icon'
import type { MenuItem } from '@/components/Menu'
import { PROJECTS_KEY } from '@/app/projects'
import { harnessLabel, PERMISSION_MODE_LABELS } from '@/screens/shared/format'
import { useToast } from '@/components/Toast'
import { attachmentProblem, messageProblem, readAttachment } from './attachments'
import { composerMode } from './sessionView'
import { rememberRuntime } from '@/screens/shared/lastRuntime'
import {
  mergeCommands,
  odinCommands,
  parseOdinCommand,
  resolveModel,
  toComposerCommands,
} from './slashCommands'
import { useDrafts, type DraftAttachment } from '@/app/drafts'
import { registerCommand } from '@/app/commands'
import { keyLabel, registerShortcut } from '@/app/shortcuts'
import { parseSideCommand } from './SideThreads'
import { completeMessageAttempt, messageAttempt, unresolvedMessages } from './sendAttempt'

const SIDE_KEYS = 'Alt+/'

const props = withDefaults(
  defineProps<{
    sessionId: string
    /** The session's project, for `/clear`. */
    project?: string | null
    /** Every project the session can reach (its working project first); the + menu offers the rest. */
    projects?: string[]
    harness?: string
    state: SessionState
    effort?: import('@odin/shared/api').Effort | null
    model?: string | null
    models?: ModelInfo[]
    permissionMode?: PermissionMode
    permissionModes?: PermissionMode[]
    /** From the harness's init event; empty until one arrives. */
    slashCommands?: SlashCommand[]
    context?: { used: number; max: number }
    /** Something waits for the user: the `replacement` slot shows instead of the message box. */
    replaced?: boolean
    /** Queued messages that Send now can release. Messages already handed off are not counted. */
    queued?: number
    /** An uncertain receipt is blocking the queue. */
    queueBlocked?: boolean
    /** Identifies what the replacement shows (the prompt's id), so answering one is noticed. */
    replacementKey?: string | null
    hasActivity?: boolean
  }>(),
  {
    slashCommands: () => [],
    project: null,
    projects: () => [],
    harness: 'claude',
    replaced: false,
    replacementKey: null,
    queued: 0,
    queueBlocked: false,
    hasActivity: false,
    effort: null,
    model: null,
    models: () => [],
    permissionMode: 'default',
    permissionModes: () => [],
  },
)

const emit = defineEmits<{
  sent: [session: Session]
  updated: [session: Session]
  /** A side question was asked: the new side thread. */
  aside: [session: Session]
  queue: [queue: MessageQueue]
}>()

const api = useApi()
const router = useRouter()
const { toast } = useToast()

// optional: a composer outside the app shell (a side thread, tests) just has no projects to offer
const store = inject(PROJECTS_KEY, null)
// Adding a project changes what the harness process is started with, so it waits for the turn to end.
const addActions = computed<MenuItem[]>(() => {
  const rest = (store?.projects.value ?? []).filter(
    p => !p.missing && p.name !== props.project && !props.projects.includes(p.name),
  )
  const busy = props.state === 'running' || props.state === 'waiting'
  return [
    {
      id: 'add-project',
      label: 'Add project',
      icon: 'folder',
      description: busy
        ? 'Available when the current turn ends'
        : rest.length
          ? undefined
          : 'Every project is already in this session',
      disabled: busy || !rest.length,
      items: rest.map(p => ({ id: `project:${p.name}`, label: p.title })),
    },
  ]
})
async function onAction(id: string) {
  if (id.startsWith('project:')) await addProject(id.slice(8))
}
async function addProject(name: string) {
  if (updating.value) return
  updating.value = true
  try {
    emit('updated', await api.updateSession(props.sessionId, { addProjects: [name] }))
    toast({
      title: `Added ${store?.projects.value.find(p => p.name === name)?.title ?? name}`,
      description: 'The next message can use it.',
      intent: 'success',
    })
  } catch (e) {
    toast({
      title: "Couldn't add the project",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    updating.value = false
  }
}

const effortOptions = computed(() => effortChoices(props.models, props.model))
const updating = ref(false)
const modeAnnouncement = ref('')
const modeLabel = computed(() => PERMISSION_MODE_LABELS[props.permissionMode])
// Model and mode can change at any time: a session without a live handle stores them for its resume.
const composerModels = computed(() => {
  const options = props.models.map(m => ({
    id: m.value,
    label: m.displayName,
    hint: m.description,
    ...pickerExtras(m),
  }))
  const current = props.model
  if (current && !findModel(props.models, current))
    options.unshift({ id: current, label: current, hint: 'Current model' })
  return options
})
const currentModel = computed(
  () => findModel(props.models, props.model)?.value ?? props.model ?? '',
)
async function updateSettings(request: {
  effort?: import('@odin/shared/api').Effort | null
  model?: string
  permissionMode?: PermissionMode
  title?: string
}) {
  if (updating.value) return
  updating.value = true
  try {
    const session = await api.updateSession(props.sessionId, request)
    if (session.id !== props.sessionId) return
    if (request.model || request.permissionMode)
      rememberRuntime(props.harness, {
        ...(request.model ? { model: request.model } : {}),
        ...(request.permissionMode ? { permissionMode: request.permissionMode } : {}),
      })
    emit('updated', session)
    if (request.permissionMode)
      modeAnnouncement.value = 'Permission mode: ' + PERMISSION_MODE_LABELS[request.permissionMode]
  } catch (e) {
    toast({
      title: "Couldn't update session settings",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    updating.value = false
  }
}
function setModel(model: string | undefined) {
  if (!model || model === currentModel.value) return
  // keep the effort if the new model offers it, otherwise go back to Auto
  const keeps = !props.effort || effortChoices(props.models, model).some(o => o.id === props.effort)
  void updateSettings({ model, ...(keeps ? {} : { effort: null }) })
}
function cycleMode() {
  const modes = (Object.keys(PERMISSION_MODE_LABELS) as PermissionMode[]).filter(m =>
    props.permissionModes.includes(m),
  )
  if (!modes.length) return
  const next = modes[(modes.indexOf(props.permissionMode) + 1) % modes.length]!
  void updateSettings({ permissionMode: next })
}
const text = ref('')
const files = ref<ChatAttachment[]>([])
// what each chip stands for, by chip id
const payloads = new Map<string, Attachment>()
const sending = ref(false)
const interrupting = ref(false)
const unresolved = computed(() =>
  unresolvedMessages.value.filter(a => a.sessionId === props.sessionId),
)
const root = ref<HTMLElement | null>(null)

// ── draft ──
const drafts = useDrafts()
// the key the box's contents belong to; moves with sessionId before anything is saved under the new id
let draftKey = ''
let offDraft: () => void = () => {}
const draftOf = (): DraftAttachment[] =>
  files.value.flatMap(chip => {
    const payload = payloads.get(chip.id)
    return payload ? [{ chip, payload }] : []
  })
function restoreDraft() {
  const d = drafts.get(draftKey)
  payloads.clear()
  for (const a of d.attachments) payloads.set(a.chip.id, a.payload)
  text.value = d.text
  files.value = d.attachments.map(a => a.chip)
}
function saveDraft() {
  drafts.set(draftKey, { text: text.value, attachments: draftOf() })
}
// another part of the app changed this draft (a side thread's Insert into message)
function onDraftChanged() {
  const d = drafts.get(draftKey)
  if (
    d.text === text.value &&
    d.attachments.length === files.value.length &&
    d.attachments.every((a, i) => a.chip.id === files.value[i]?.id)
  )
    return
  restoreDraft()
}
watch(
  () => props.sessionId,
  id => {
    offDraft()
    draftKey = id
    restoreDraft()
    offDraft = drafts.subscribe(id, onDraftChanged)
  },
  { flush: 'sync', immediate: true },
)
watch([text, files], saveDraft)

// ── side questions ──
const sideMode = ref(false)
const asking = ref(false)
async function askSide(payload: { text: string; attachments: ChatAttachment[] }) {
  if (asking.value) return
  const key = draftKey
  const id = props.sessionId
  const attachments = payload.attachments
    .map(a => payloads.get(a.id))
    .filter((a): a is Attachment => !!a)
  const problem = messageProblem({ text: payload.text, attachments })
  if (problem) {
    giveBack(key, payload)
    toast({ title: "Couldn't ask the side question", description: problem, intent: 'warning' })
    return
  }
  asking.value = true
  try {
    const side = await api.forkSession(id, {
      aside: true,
      prompt: { text: payload.text, ...(attachments.length ? { attachments } : {}) },
    })
    for (const a of payload.attachments) payloads.delete(a.id)
    drafts.clear(key)
    sideMode.value = false
    emit('aside', side)
  } catch (e) {
    giveBack(key, payload)
    toast({
      title: "Couldn't ask the side question",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    asking.value = false
  }
}
/** Puts an unsent message back (in the box when it is still showing that draft, and in the store). */
function giveBack(key: string, payload: { text: string; attachments: ChatAttachment[] }) {
  const attachments = payload.attachments.flatMap(chip => {
    const p = payloads.get(chip.id)
    return p ? [{ chip, payload: p }] : []
  })
  if (key === draftKey) {
    text.value = payload.text
    files.value = payload.attachments
  }
  drafts.set(key, { text: payload.text, attachments })
}
/** ⌥↵ in the message box: ask on the side. Runs before the box's own Enter handling (capture). */
function onBoxKeydown(event: KeyboardEvent) {
  if (
    event.key !== 'Enter' ||
    !event.altKey ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.isComposing ||
    !(event.target instanceof HTMLTextAreaElement) ||
    !!event.target.closest('.session-composer__takeover')
  )
    return
  event.preventDefault()
  event.stopPropagation()
  const payload = { text: text.value.trim(), attachments: [...files.value] }
  if (!payload.text || asking.value) return
  text.value = ''
  files.value = []
  void askSide(payload)
}
const textarea = () => root.value?.querySelector<HTMLTextAreaElement>('textarea') ?? null
/** ⌥/: side question mode on, caret in the box (the user asked for it). Nothing while a prompt has the box's place. */
function openSideQuestion() {
  if (props.replaced) return
  sideMode.value = true
  textarea()?.focus()
}
// ⌥/ and the palette's "Ask a side question", while this composer is mounted
let withdrawShortcut: () => void = () => {}
let withdrawCommand: () => void = () => {}
let withdrawSendNow: () => void = () => {}
watch(
  () => props.replaced,
  replaced => {
    withdrawCommand()
    withdrawCommand = registerCommand({
      id: 'session-side-question',
      label: 'Ask a side question',
      icon: 'message',
      hint: keyLabel(SIDE_KEYS),
      ...(replaced ? { disabledReason: 'Answer the open prompt first' } : {}),
      run: openSideQuestion,
    })
  },
  { immediate: true },
)
const typing = ref(false)
const editable = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  )
function onFocus(event: FocusEvent) {
  const target = event.type === 'focusout' ? event.relatedTarget : event.target
  // Keep the hint stable while focus moves from the textarea to Send or another composer control. At narrow
  // widths switching to the shorter pause hint can move Send between pointerdown and pointerup, losing the click.
  typing.value = editable(target) || (target instanceof Node && !!root.value?.contains(target))
}
function onPauseKey(event: KeyboardEvent) {
  if (
    event.key !== 'Escape' ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    props.state !== 'running' ||
    props.replaced ||
    interrupting.value ||
    editable(event.target) ||
    editable(document.activeElement)
  )
    return
  // Escape belongs to an open menu, dialog or expanded file view before the session.
  if (
    document.querySelector(
      'dialog[open], [role="menu"], [aria-modal="true"], .session-files--expanded',
    )
  )
    return
  if (event.target instanceof Element && event.target.closest('.iu-side-panel, .session-files'))
    return
  event.preventDefault()
  void interrupt()
}
onMounted(() => {
  typing.value = editable(document.activeElement)
  document.addEventListener('focusin', onFocus)
  document.addEventListener('focusout', onFocus)
  window.addEventListener('keydown', onPauseKey)
  withdrawShortcut = registerShortcut({
    id: 'session-side-question',
    keys: SIDE_KEYS,
    label: 'Ask a side question',
    group: 'Session',
    whileTyping: true,
    run: openSideQuestion,
  })
})
onBeforeUnmount(() => {
  document.removeEventListener('focusin', onFocus)
  document.removeEventListener('focusout', onFocus)
  window.removeEventListener('keydown', onPauseKey)
  withdrawShortcut()
  withdrawCommand()
  withdrawSendNow()
  offDraft()
})

const mode = computed(() => composerMode(props.state, sending.value))
// Odin's own commands run here and are never sent; they win over harness commands with the same names.
const ownCommands = computed(() =>
  odinCommands({
    model: composerModels.value.length > 0,
    effort: effortOptions.value.map(o => o.id),
  }).map(c =>
    c.name === 'model' && props.models.length
      ? {
          ...c,
          choices: props.models.map(m => ({ label: m.displayName, insert: m.value, hint: '' })),
        }
      : c,
  ),
)
const commands = computed<ComposerCommand[]>(() =>
  toComposerCommands(mergeCommands(ownCommands.value, props.slashCommands)),
)
const searchFiles = async (query: string) =>
  (await api.searchSessionFiles(props.sessionId, query)).matches

/** Runs one of Odin's commands; false when `text` isn't one (send it to the agent). */
function runOwnCommand(message: string): boolean {
  const cmd = parseOdinCommand(message, ownCommands.value)
  if (!cmd) return false
  if (cmd.name === 'clear') {
    void router.push({
      path: '/',
      query: { launch: '1', ...(props.project ? { project: props.project } : {}) },
    })
  } else if (cmd.name === 'model') {
    const model = resolveModel(cmd.arg, props.models)
    if (!model) {
      void nextTick(() => (text.value = message)) // the composer clears its draft after submit
      toast({ title: 'Name a model', description: 'Usage: /model <model>', intent: 'warning' })
    } else setModel(model)
  } else if (cmd.name === 'effort') {
    const value = cmd.arg.toLowerCase()
    if (value === 'default' || effortOptions.value.some(o => o.id === value)) {
      void updateSettings({ effort: value === 'default' ? null : asEffort(value) })
    } else {
      void nextTick(() => (text.value = message))
      toast({
        title: 'Choose an effort level',
        description:
          'Usage: /effort ' + ['default', ...effortOptions.value.map(o => o.id)].join(' | '),
        intent: 'warning',
      })
    }
  } else if (cmd.name === 'rename') {
    if (!cmd.arg) {
      void nextTick(() => (text.value = message)) // the composer clears its draft after submit
      toast({ title: 'Give a title', description: 'Usage: /rename <title>', intent: 'warning' })
    } else void updateSettings({ title: cmd.arg })
  } else if (cmd.name === 'btw') {
    // /btw with a question is handled before this; bare /btw asks for one.
    void nextTick(() => (text.value = message))
    toast({ title: 'Ask a question', description: 'Usage: /btw <question>', intent: 'warning' })
  } else if (cmd.name === 'send') {
    if (cmd.arg) {
      const attempt = messageAttempt(props.sessionId, { text: cmd.arg })
      void deliverNow(attempt)
    } else void deliverNow()
  }
  return true
}
const placeholder = computed(() =>
  sideMode.value
    ? 'Ask a side question (this session keeps going)…'
    : props.state === 'waiting'
      ? 'Answer the prompt above first'
      : props.state === 'running'
        ? `Queue a message for ${harnessLabel(props.harness)}…`
        : `Message ${harnessLabel(props.harness)}…`,
)

async function onAttach(list: File[]) {
  for (const file of list) {
    const r = await readAttachment(file)
    if (!r.ok) {
      toast({ title: "Couldn't attach that file", description: r.reason, intent: 'warning' })
      continue
    }
    const problem = attachmentProblem([
      ...files.value.flatMap(chip => payloads.get(chip.id) ?? []),
      r.attachment,
    ])
    if (problem) {
      toast({ title: "Couldn't attach that file", description: problem, intent: 'warning' })
      continue
    }
    const id = crypto.randomUUID()
    payloads.set(id, r.attachment)
    files.value = [
      ...files.value,
      {
        id,
        name: file.name,
        size: file.size,
        kind: r.attachment.mediaType.startsWith('image/') ? 'image' : 'file',
        status: 'ready',
      },
    ]
  }
}

async function onSubmit(payload: { text: string; attachments: ChatAttachment[] }) {
  if (sending.value) return
  const question = parseSideCommand(payload.text)
  if (sideMode.value || question !== null) {
    void askSide(question !== null ? { ...payload, text: question } : payload)
    return
  }
  if (!payload.attachments.length && runOwnCommand(payload.text)) return
  const id = props.sessionId
  const attachments = payload.attachments
    .map(a => payloads.get(a.id))
    .filter((a): a is Attachment => !!a)
  const problem = messageProblem({ text: payload.text, attachments })
  if (problem) {
    giveBack(id, payload)
    toast({ title: "Couldn't send that message", description: problem, intent: 'warning' })
    return
  }
  const message = messageAttempt(id, {
    text: payload.text,
    ...(attachments.length ? { attachments } : {}),
  })
  await sendAttempt(id, message)
  for (const a of payload.attachments)
    if (!files.value.some(file => file.id === a.id)) payloads.delete(a.id)
}

async function sendAttempt(id: string, message: UserMessage) {
  if (sending.value) return
  sending.value = true
  try {
    const session = await api.sendMessage(id, message)
    completeMessageAttempt(id, message.clientId!)
    if (id === props.sessionId) emit('sent', session)
  } catch (e) {
    toast({
      title: 'Message acknowledgement was lost',
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    // Reconcile both success and uncertain HTTP outcomes. SSE may have disconnected during the request.
    try {
      const queue = await api.queue(id)
      for (const receipt of queue.messages)
        if (receipt.message.clientId) completeMessageAttempt(id, receipt.message.clientId)
      if (id === props.sessionId) emit('queue', queue)
    } catch {
      /* The next SSE reconnect/detail load restores the server snapshot. */
    }
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

async function deliverNow(message?: UserMessage) {
  if (sending.value || interrupting.value) return
  if (props.queueBlocked) {
    toast({
      title: 'Resolve the queue first',
      description: 'An earlier message may have been delivered. Dismiss or retry it, then send.',
      intent: 'warning',
    })
    return
  }
  const id = props.sessionId
  sending.value = true
  interrupting.value = true
  try {
    const queue = await api.sendNow(id, message)
    if (message?.clientId) completeMessageAttempt(id, message.clientId)
    if (id === props.sessionId) emit('queue', queue)
  } catch (e) {
    toast({
      title: "Couldn't send now",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    try {
      const queue = await api.queue(id)
      for (const receipt of queue.messages)
        if (receipt.message.clientId) completeMessageAttempt(id, receipt.message.clientId)
      if (id === props.sessionId) emit('queue', queue)
    } catch {
      /* The next SSE reconnect restores the server snapshot. */
    }
    sending.value = false
    interrupting.value = false
  }
}

function draftMessage(): UserMessage | undefined {
  const attachments = files.value.map(a => payloads.get(a.id)).filter((a): a is Attachment => !!a)
  const body = text.value.trim()
  if (!body && !attachments.length) return undefined
  text.value = ''
  files.value = []
  return messageAttempt(props.sessionId, {
    text: body,
    ...(attachments.length ? { attachments } : {}),
  })
}

async function sendDraftNow() {
  const attachments = files.value.flatMap(file => payloads.get(file.id) ?? [])
  const problem = messageProblem({ text: text.value, attachments })
  if (problem) {
    toast({ title: "Couldn't send now", description: problem, intent: 'warning' })
    return
  }
  const message = draftMessage()
  if (message) await deliverNow(message)
  else await deliverNow()
}

watch(
  [
    () => props.replaced,
    () => props.state,
    () => props.queued,
    () => props.queueBlocked,
    text,
    files,
  ],
  () => {
    withdrawSendNow()
    const draft = text.value.trim().length > 0 || files.value.length > 0
    const ready =
      !props.replaced &&
      !props.queueBlocked &&
      ((props.state === 'running' && draft) || (props.queued ?? 0) > 0)
    const disabledReason = props.queueBlocked
      ? 'Resolve uncertain messages first'
      : props.replaced
        ? 'Answer the open prompt first'
        : 'Nothing waiting to send'
    withdrawSendNow = registerCommand({
      id: 'session-send-now',
      label: 'Send now',
      icon: 'arrowUp',
      hint: '/send',
      ...(ready ? {} : { disabledReason }),
      run: () => {
        void sendDraftNow()
      },
    })
  },
  { immediate: true },
)

// ── focus across the takeover ──
const takeover = ref<HTMLElement | null>(null)
let answeredFromPrompt = false
watch(
  () => [props.replaced, props.replacementKey] as const,
  async () => {
    // only when the user was working inside the prompt that is going away
    if (!answeredFromPrompt) return
    answeredFromPrompt = false
    await nextTick()
    const active = document.activeElement
    if (active && active !== document.body && root.value?.contains(active)) return
    if (props.replaced) takeover.value?.querySelector<HTMLElement>('.session-prompts')?.focus()
    else root.value?.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  },
  { flush: 'pre' },
)
function onTakeoverFocus() {
  answeredFromPrompt = true
}
function onTakeoverBlur(e: FocusEvent) {
  // focus left for somewhere else on the page: no hand-off later
  if (e.relatedTarget && !takeover.value?.contains(e.relatedTarget as Node))
    answeredFromPrompt = false
}
</script>

<template>
  <div ref="root" class="session-composer" @keydown.capture="onBoxKeydown">
    <template v-if="!sending">
      <IuCallout
        v-for="attempt in unresolved"
        :key="attempt.message.clientId"
        intent="warning"
        variant="subtle"
        title="Message not acknowledged"
      >
        <p>{{ attempt.message.text }}</p>
        <p v-if="attempt.message.attachments?.length">
          Attachments: {{ attempt.message.attachments.map(a => a.name).join(', ') }}
        </p>
        <p>
          The server may have accepted this message. Retry checks the same request without adding it
          twice.
        </p>
        <template #actions>
          <IuButton size="sm" @click="sendAttempt(sessionId, attempt.message)"
            >Retry original message</IuButton
          >
          <IuButton
            size="sm"
            variant="ghost"
            @click="completeMessageAttempt(sessionId, attempt.message.clientId!)"
            >Dismiss local copy</IuButton
          >
        </template>
      </IuCallout>
    </template>
    <div class="session-composer__row">
      <div class="session-composer__box">
        <IuComposerSurface :joined="hasActivity">
          <template #activity><slot name="activity" /></template>
          <div
            v-if="replaced"
            ref="takeover"
            class="session-composer__takeover"
            :class="{ 'session-composer__takeover--joined': hasActivity }"
            @focusin="onTakeoverFocus"
            @focusout="onTakeoverBlur"
          >
            <slot name="replacement" />
          </div>
          <IuComposer
            v-show="!replaced"
            :embedded="hasActivity"
            v-model="text"
            v-model:attachments="files"
            :placeholder="placeholder"
            :min-rows="2"
            :disabled="mode.disabled"
            :commands="commands"
            :search-files="searchFiles"
            :context="context"
            :models="composerModels"
            :model-id="currentModel"
            :effort="effort"
            :cycle-on-shift-tab="!updating"
            @update:model-id="setModel"
            @update:effort="updateSettings({ effort: asEffort($event ?? '') })"
            @cycle="cycleMode"
            :stoppable="state === 'running'"
            :stopping="interrupting"
            stop-label="Interrupt"
            @submit="onSubmit"
            :actions="addActions"
            @attach="onAttach"
            @action="onAction"
            @stop="interrupt"
          >
            <template #controls>
              <IuButton
                variant="ghost"
                size="sm"
                :disabled="updating || !permissionModes.length"
                :aria-label="'Permission mode: ' + modeLabel + '. Activate to change'"
                :data-mode="permissionMode"
                @click="cycleMode"
              >
                <template #icon><IuIcon name="lock" :size="14" /></template>{{ modeLabel }}
              </IuButton>
              <IuButton
                v-if="
                  state === 'running' && !replaced && !sideMode && (text.trim() || files.length)
                "
                variant="ghost"
                size="sm"
                :disabled="sending || interrupting || queueBlocked"
                title="Send now and interrupt"
                @click="sendDraftNow"
                >Send now</IuButton
              >
            </template>
            <template #hint-start>
              <span class="session-composer__reason">Shift+Tab change mode</span>
            </template>
            <template #hint>
              <span v-if="sideMode">↵ ask on the side · ⇧↵ newline</span>
              <span v-else-if="state === 'running' && !typing">Esc pause</span>
              <span v-else-if="state === 'running'"
                >↵ send queues · Send now interrupts · /send</span
              >
              <span v-else>↵ send · ⌥↵ side question · / commands · @ files</span>
            </template>
          </IuComposer>
        </IuComposerSurface>
      </div>
    </div>
    <span class="sr-only" role="status" aria-live="polite">{{ modeAnnouncement }}</span>
  </div>
</template>

<style>
.session-composer {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.session-composer__row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.session-composer__box {
  flex: 1;
  min-width: 0;
}
.session-composer__takeover {
  /* a long plan or diff scrolls here; the dock keeps its place at the bottom */
  max-height: min(60vh, 560px);
  overflow-y: auto;
  border-radius: var(--iu-radius-lg);
}
.session-composer__reason {
  color: var(--iu-text-2);
}
.session-composer__takeover--joined {
  border: 1px solid var(--iu-border);
  border-top: 0;
  border-radius: 0 0 var(--iu-radius-lg) var(--iu-radius-lg);
  background: var(--iu-surface);
}
</style>
