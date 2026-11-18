<script setup lang="ts">
// The conversation: user turns, Claude's text (markdown), system lines, and each run of work (thinking, tool calls,
// commands, agents) as one rail inside an assistant turn (steps.ts, rail.ts, components/Rail). A step that posted an
// artifact keeps a card under its line (the artifact itself shows in the artifact column; the card selects it there).
// New content never takes focus; the list follows the bottom only while the reader is already there (IuMessageList).
// A step that worked on a workspace file or a notebook cell offers to open it in the Files tab (fileActivity.ts).
import { computed, ref } from 'vue'
import type { TranscriptEntry } from '@odin/shared/harness'
import { taskKey } from '@odin/shared/harness'
import type { ChatAuthor, ChatMessage } from '@/components/Chat'
import { IuMessage, IuMessageList } from '@/components/Chat'
import { IuCallout } from '@/components/Callout'
import { IuEmpty } from '@/components/States'
import { IuRail } from '@/components/Rail'
import { IuToolCall } from '@/components/ToolCall'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import type { ToolCallView } from '@/components/ToolCall'
import { harnessLabel } from '@/screens/shared/format'
import ArtifactCard from './ArtifactCard.vue'
import InjectedNotice from './InjectedNotice.vue'
import type { Row } from './sessionView'
import {
  entryTimes,
  foldRuns,
  runBusy,
  runFlock,
  runFolded,
  runLabel,
  runRunning,
  runningAgents,
  type RunItem,
} from './steps'
import { railRun } from './rail'
import { useElapsed } from './useElapsed'
import { entryCell, entryFile, type CellRef } from './fileActivity'

const props = withDefaults(
  defineProps<{
    harness?: string
    rows: Row[]
    /** Claude is working and nothing is streaming yet: show a working line at the end. */
    working: boolean
    /** The artifact version on show in the artifact column, to mark its card. */
    currentArtifact?: { id: number; version: number } | null
    /** The transcript the rows came from: its timestamps time the steps. */
    entries?: TranscriptEntry[]
    /** The session's cwd (project or worktree path): tool calls show file paths relative to it. */
    root?: string | null
    /** Child history can contain tasks without a parent-authorized preview endpoint. */
    taskActions?: boolean
    /** The list's accessible name; a second thread on screen (a side thread) needs its own. */
    label?: string
  }>(),
  { taskActions: true, label: 'Conversation' },
)

const items = computed(() => foldRuns(props.rows, props.entries ?? []))
const times = computed(() => entryTimes(props.entries ?? []))
const runMessage = (item: RunItem): ChatMessage => ({
  id: item.id,
  role: 'assistant',
  author: author(),
  at: '',
  parts: [],
})

// the run at the live end of the thread: open, no summary, until something follows it
const lastItem = computed(() => items.value[items.value.length - 1])
const isLive = (item: RunItem) => item === lastItem.value && (props.working || runRunning(item))
// the user's own fold/unfold, kept per run id for the life of the screen
const overrides = ref<Record<string, boolean>>({})
const folded = (item: RunItem) =>
  runFolded(item, { live: isLive(item), override: overrides.value[item.id] })
// The working line. A live run carries it at its own end (the rail's tail), where its flock can come down into the
// run's summary; with no run at the end of the thread it is a line of its own. A step that is running says so itself,
// so the line waits, except for agents: the session goes on working while they are out.
const tailWorking = (item: RunItem) => props.working && isLive(item) && !runBusy(item)
const looseWorking = computed(() => props.working && lastItem.value?.kind !== 'run')
const agentsOut = computed(() => runningAgents(props.rows))
const clock = useElapsed(() => items.value.some(i => i.kind === 'run' && runRunning(i)))

// the rail for each run; `after` times its last step by whatever followed
const rails = computed(() => {
  const out = new Map<string, ReturnType<typeof railRun>>()
  items.value.forEach((item, i) => {
    if (item.kind !== 'run') return
    const next = items.value[i + 1]
    const after = next && 'entry' in next ? (times.value.get(next.id) ?? null) : null
    out.set(item.id, railRun(item, { root: props.root, times: times.value, after }))
  })
  return out
})

const emit = defineEmits<{
  'open-artifact': [id: number, version: number]
  'open-task': [id: string]
  /** A step that worked on a file: open it in the Files tab (path relative to the working directory). */
  'open-file': [path: string]
  /** A step that ran or edited a notebook cell: open its notebook at that cell. */
  'open-cell': [cell: CellRef]
}>()

// A step's file or notebook cell, when it has one: read from its transcript entry, else from the call's view.
const toolEntries = computed(() => {
  const out = new Map<string, Extract<TranscriptEntry, { kind: 'tool' }>>()
  for (const e of props.entries ?? []) if (e.kind === 'tool') out.set(e.id, e)
  return out
})
const asEntry = (call: ToolCallView): Extract<TranscriptEntry, { kind: 'tool' }> =>
  toolEntries.value.get(call.id) ?? {
    kind: 'tool',
    id: call.id,
    name: call.name,
    input: call.input,
    ...(call.result
      ? { result: { ok: true, text: call.result.text, truncated: !!call.result.truncated } }
      : {}),
    at: null,
    parentToolUseId: null,
  }
const stepFile = (call: ToolCallView) => entryFile(asEntry(call), props.root)
const stepCell = (call: ToolCallView) => entryCell(asEntry(call))

const YOU: ChatAuthor = { name: 'You', kind: 'person', id: 'you' }
const author = (): ChatAuthor => ({
  name: harnessLabel(props.harness ?? ''),
  kind: 'agent',
  id: props.harness ?? 'claude',
})

function message(row: Row): ChatMessage {
  switch (row.kind) {
    case 'user':
      return {
        id: row.id,
        role: 'user',
        author: YOU,
        at: row.entry.at ?? '',
        parts: [
          { type: 'text', text: row.entry.text },
          ...(row.entry.attachments?.length
            ? [
                {
                  type: 'attachments' as const,
                  files: row.entry.attachments.map((a, i) => ({
                    id: `${row.id}-${i}`,
                    name: a.name,
                    kind: a.mediaType.startsWith('image/') ? ('image' as const) : ('file' as const),
                  })),
                },
              ]
            : []),
        ],
      }
    case 'assistant':
      return {
        id: row.id,
        role: 'assistant',
        author: author(),
        at: row.entry.at ?? '',
        parts: [{ type: 'text', text: row.entry.text }],
        streaming: row.streaming,
      }
    case 'thinking':
      return {
        id: row.id,
        role: 'assistant',
        author: author(),
        at: row.entry.at ?? '',
        parts: [{ type: 'thinking', text: row.entry.text }],
        streaming: row.streaming,
      }
    case 'tool':
    case 'task':
      return { id: row.id, role: 'assistant', author: author(), at: '', parts: [] }
    case 'injected':
    case 'system':
      return {
        id: row.id,
        role: 'system',
        author: author(),
        at: row.entry.at ?? '',
        parts: [{ type: 'text', text: row.entry.text }],
      }
  }
}

const WORKING = computed<ChatMessage>(() => ({
  id: 'working',
  role: 'assistant',
  author: author(),
  at: '',
  parts: [],
  streaming: true,
}))
</script>

<template>
  <IuMessageList :aria-label="label" :empty="rows.length === 0 && !working">
    <template v-for="row in items" :key="row.id">
      <IuMessage
        v-if="row.kind === 'run'"
        :message="runMessage(row)"
        :show-header="row.head"
        :actions="false"
      >
        <IuRail
          v-if="rails.get(row.id)"
          :steps="rails.get(row.id)!.steps"
          :label="runLabel(row)"
          :live="isLive(row)"
          :working="tailWorking(row)"
          :agents="agentsOut"
          :flock="runFlock(row, { live: isLive(row) })"
          :folded="folded(row)"
          :root="root"
          :now="clock"
          @update:folded="v => (overrides[row.id] = v)"
        >
          <template #body="{ step }">
            <template v-for="(body, i) in [rails.get(row.id)!.bodies.get(step.id)]" :key="i">
              <IuToolCall v-if="body?.kind === 'call'" :call="body.call" :root="root" bare />
              <p v-else-if="body?.kind === 'thinking'" class="session-thread__thought">
                {{ body.text }}
              </p>
              <p v-else-if="body?.kind === 'agent'" class="session-thread__thought">
                {{ body.summary }}
              </p>
            </template>
          </template>
          <template #actions="{ step }">
            <template v-for="(r, i) in [rails.get(row.id)!.rows.get(step.id)]" :key="i">
              <IuButton
                v-if="taskActions && r?.kind === 'task' && r.task.kind === 'agent'"
                size="sm"
                variant="ghost"
                @click="emit('open-task', r.id)"
                >Open agent</IuButton
              >
              <IuButton
                v-else-if="taskActions && r?.kind === 'tool' && r.task?.kind === 'agent'"
                size="sm"
                variant="ghost"
                @click="emit('open-task', taskKey(r.task))"
                >Open agent</IuButton
              >
              <template v-else-if="r?.kind === 'tool'">
                <IuButton
                  v-if="stepFile(r.call)"
                  size="sm"
                  variant="ghost"
                  icon-only
                  :aria-label="`Open ${stepFile(r.call)} in Files`"
                  title="Open in Files"
                  @click="emit('open-file', stepFile(r.call)!)"
                >
                  <template #icon><IuIcon name="panelRight" :size="14" /></template>
                </IuButton>
                <IuButton
                  v-else-if="stepCell(r.call)"
                  size="sm"
                  variant="ghost"
                  icon-only
                  aria-label="Open this notebook cell in Files"
                  title="Open cell in Files"
                  @click="emit('open-cell', stepCell(r.call)!)"
                >
                  <template #icon><IuIcon name="panelRight" :size="14" /></template>
                </IuButton>
              </template>
            </template>
          </template>
          <template #after="{ step }">
            <template v-for="(r, i) in [rails.get(row.id)!.rows.get(step.id)]" :key="i">
              <ArtifactCard
                v-if="r?.kind === 'tool' && r.artifact"
                class="session-thread__card"
                :artifact="r.artifact"
                :current="
                  r.artifact.id === currentArtifact?.id &&
                  r.artifact.version === currentArtifact?.version
                "
                @open="(id, version) => emit('open-artifact', id, version)"
              />
            </template>
          </template>
        </IuRail>
      </IuMessage>
      <InjectedNotice v-else-if="row.kind === 'injected'" :entry="row.entry" />
      <IuCallout
        v-else-if="row.kind === 'system' && row.entry.level !== 'info'"
        :intent="row.entry.level === 'error' ? 'danger' : 'warning'"
        variant="subtle"
        >{{ row.entry.text }}</IuCallout
      >
      <IuMessage
        v-else
        :message="message(row)"
        :show-header="row.kind !== 'system' && row.head"
        :actions="row.kind === 'assistant' || row.kind === 'user'"
        :regenerate="false"
      />
    </template>
    <IuMessage
      v-if="looseWorking"
      :message="WORKING"
      :agents="agentsOut"
      :show-header="false"
      :actions="false"
    />
    <template #empty>
      <IuEmpty title="No messages yet" body="Send a message below to start the conversation." />
    </template>
  </IuMessageList>
</template>

<style>
.session-thread__thought {
  margin: 0;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
  line-height: var(--iu-leading-relaxed);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.session-thread__card {
  margin-top: 6px;
}
</style>
