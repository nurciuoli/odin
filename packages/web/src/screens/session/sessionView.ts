// The Session screen's view model, as pure functions so the folding rules are testable without a DOM.
// A SessionView is a SessionDetail plus what only live events carry (streaming ids, the last turn's outcome). `applySessionEvent` folds one `session.event` frame into it with `applyHarnessEvent` for the transcript;
// `applySessionRecord` takes a `session.updated` record. `buildRows` turns the transcript into what the thread shows.
import type {
  PermissionAnswer,
  PermissionMode,
  Session,
  SessionDetail,
  SessionState,
} from '@odin/shared/api'
import type { HarnessEvent, PermissionRequest, TranscriptEntry } from '@odin/shared/harness'
import { taskKey } from '@odin/shared/harness'
import { applyHarnessEvent } from '@odin/shared/transcript'
import type { PermissionPromptAnswer, PermissionPromptRequest } from '@/components/PermissionPrompt'
import type { ToolCallView } from '@/components/ToolCall'
import { diffLines, type DiffHunk } from '@/components/CodeBlock'
import { taskStatus, taskStateLabel } from './activity'
import type { TaskActivity } from '@odin/shared/harness'

type ToolEntry = Extract<TranscriptEntry, { kind: 'tool' }>
type SystemEntry = Extract<TranscriptEntry, { kind: 'system' }>
export type InjectedEntry = Extract<TranscriptEntry, { kind: 'injected' }>

/** The one-line label of a message the harness injected (never the user's "You"). */
export function injectedLabel(entry: Pick<InjectedEntry, 'source' | 'from'>): string {
  const from = entry.from?.trim()
  switch (entry.source) {
    case 'agent':
      return from ? `Agent report from ${from}` : 'Agent report'
    case 'peer':
      return from ? `Message from session ${from}` : 'Message from another session'
    case 'channel':
      return from ? `Channel message from ${from}` : 'Channel message'
    case 'task':
      return 'Background task finished'
    case 'scheduled':
      return 'Scheduled wakeup'
    case 'system':
      return 'System notice'
  }
}

export interface SessionView {
  detail: SessionDetail
  /** Entry ids still receiving deltas (no whole `entry` yet). */
  streaming: string[]
  /** How the last turn ended, while nothing newer has happened. */
  lastTurn: { ok: boolean; error: string | null } | null
  /** Local system lines (notices, a failed turn), numbered so their ids stay unique. */
  noticeSeq: number
}

export function createSessionView(detail: SessionDetail): SessionView {
  return { detail, streaming: detail.streaming ?? [], lastTurn: null, noticeSeq: 0 }
}

function waitingFor(pending: PermissionRequest[]): Session['waitingFor'] {
  return pending[0]?.kind === 'question' ? 'question' : 'permission'
}

function addSystemLine(
  view: SessionView,
  level: SystemEntry['level'],
  text: string,
): Pick<SessionView, 'noticeSeq'> & { transcript: TranscriptEntry[] } {
  const seq = view.noticeSeq + 1
  const entry: SystemEntry = {
    kind: 'system',
    id: `local-notice-${seq}`,
    level,
    text,
    at: new Date().toISOString(),
    parentToolUseId: null,
  }
  return { noticeSeq: seq, transcript: [...view.detail.transcript, entry] }
}

/** Folds one live harness event into the view. Returns the same object when nothing changed. */
export function applySessionEvent(view: SessionView, event: HarnessEvent): SessionView {
  const d = view.detail
  switch (event.type) {
    case 'delta': {
      // A delta for an entry that is already whole (it was in the fetched transcript, or its `entry` came first)
      // must not append: the detail holds completed entries only, and frames can race the fetch.
      const known = d.transcript.some(e => e.id === event.entryId)
      if (known && !view.streaming.includes(event.entryId)) return view
      const transcript = applyHarnessEvent(d.transcript, event)
      const streaming = known ? view.streaming : [...view.streaming, event.entryId]
      return { ...view, streaming, lastTurn: null, detail: { ...d, transcript } }
    }
    case 'entry':
    case 'task':
    case 'tool.result': {
      const transcript = applyHarnessEvent(d.transcript, event)
      const streaming =
        event.type === 'entry' ? view.streaming.filter(id => id !== event.entry.id) : view.streaming
      if (transcript === d.transcript && streaming === view.streaming) return view
      return { ...view, streaming, detail: { ...d, transcript } }
    }
    case 'init':
      return {
        ...view,
        detail: {
          ...d,
          slashCommands: event.slashCommands,
          live: true,
          model: event.model ?? d.model,
          permissionMode: event.permissionMode ?? d.permissionMode,
        },
      }
    case 'state': {
      const state: SessionState = event.state
      return {
        ...view,
        lastTurn: state === 'running' ? null : view.lastTurn,
        detail: {
          ...d,
          live: true,
          state,
          waitingFor: state === 'waiting' ? waitingFor(d.pending) : null,
        },
      }
    }
    case 'permission.request': {
      if (d.pending.some(p => p.id === event.request.id)) return view
      return { ...view, detail: { ...d, pending: [...d.pending, event.request] } }
    }
    case 'permission.resolved': {
      if (!d.pending.some(p => p.id === event.requestId)) return view
      return { ...view, detail: { ...d, pending: d.pending.filter(p => p.id !== event.requestId) } }
    }
    case 'commands':
      return { ...view, detail: { ...d, slashCommands: event.slashCommands } }
    case 'todos':
      return { ...view, detail: { ...d, todos: event.todos } }
    case 'goal':
      return { ...view, detail: { ...d, goal: event.goal } }
    case 'model':
      return { ...view, detail: { ...d, model: event.model } }
    case 'permission.mode':
      return { ...view, detail: { ...d, permissionMode: event.mode } }
    case 'notice': {
      const line = addSystemLine(view, event.level, event.text)
      return { ...view, noticeSeq: line.noticeSeq, detail: { ...d, transcript: line.transcript } }
    }
    case 'turn.end': {
      // whatever was still streaming is as complete as it will get
      const base = { ...view, streaming: [], lastTurn: { ok: event.ok, error: event.error } }
      if (event.ok) return base
      const line = addSystemLine(
        view,
        event.error === 'interrupted' ? 'info' : 'error',
        event.error === 'interrupted'
          ? 'Interrupted.'
          : `The turn failed${event.error ? `: ${event.error}` : '.'}`,
      )
      return { ...base, noticeSeq: line.noticeSeq, detail: { ...d, transcript: line.transcript } }
    }
    case 'exit':
      return {
        ...view,
        streaming: [],
        detail: {
          ...d,
          live: false,
          pending: [],
          state: event.outcome === 'failed' ? 'failed' : 'ended',
          waitingFor: null,
          error: event.error ?? d.error,
          transcript: d.transcript.map(entry =>
            entry.kind === 'task' && entry.task.state === 'running'
              ? { ...entry, task: { ...entry.task, state: 'unknown' as const } }
              : entry,
          ),
        },
      }
    case 'usage':
      // the record (metrics) arrives as `session.updated`
      return view
  }
}

/** A `session.updated` record: the record's fields win; the conversation parts stay. */
export function applySessionRecord(view: SessionView, session: Session): SessionView {
  if (session.id !== view.detail.id) return view
  const d = view.detail
  return {
    ...view,
    detail: {
      ...d,
      ...session,
      // a record that says the harness stopped clears prompts it can no longer answer
      pending: session.state === 'waiting' || session.state === 'running' ? d.pending : [],
      live: session.state === 'running' || session.state === 'waiting' ? true : d.live,
    },
  }
}

/**
 * A record an action returned (send, answer, rename…). Its response can arrive after SSE frames that are newer (a
 * send answers `running` while the stream already said `waiting`), so an older record is dropped, and one from the
 * same instant keeps the live state the stream gave.
 */
export function applyActionRecord(view: SessionView, session: Session): SessionView {
  const d = view.detail
  if (session.id !== d.id || session.updatedAt < d.updatedAt) return view
  if (session.updatedAt === d.updatedAt)
    return applySessionRecord(view, { ...session, state: d.state, waitingFor: d.waitingFor })
  return applySessionRecord(view, session)
}

// ── the thread ────────────────────────────────────────────────────────────────

/** An artifact posted by a tool call (`post_artifact` answers "Posted artifact <id> v<n>"). */
export interface ArtifactRef {
  id: number
  version: number
  title: string
}

export type Row =
  | { kind: 'user'; id: string; entry: Extract<TranscriptEntry, { kind: 'user' }>; head: boolean }
  | {
      kind: 'assistant'
      id: string
      entry: Extract<TranscriptEntry, { kind: 'assistant' }>
      head: boolean
      streaming: boolean
    }
  | {
      kind: 'thinking'
      id: string
      entry: Extract<TranscriptEntry, { kind: 'thinking' }>
      head: boolean
      streaming: boolean
    }
  | {
      kind: 'tool'
      id: string
      call: ToolCallView
      head: boolean
      artifact: ArtifactRef | null
      task?: TaskActivity
      /** Nested command runs whose preview actions render on their nested tool rows. */
      commandTasks?: TaskActivity[]
    }
  | { kind: 'system'; id: string; entry: SystemEntry }
  | { kind: 'injected'; id: string; entry: InjectedEntry }
  | {
      kind: 'task'
      id: string
      task: import('@odin/shared/harness').TaskActivity
      head: boolean
    }

const ARTIFACT_TOOL = /(^|__)post_artifact$/
const POSTED = /Posted artifact (\d+) v(\d+)/

export function artifactRef(
  entry: ToolEntry,
  artifacts: SessionDetail['artifacts'],
): ArtifactRef | null {
  if (!ARTIFACT_TOOL.test(entry.name) || !entry.result?.ok) return null
  const m = POSTED.exec(entry.result.text)
  if (!m) return null
  const id = Number(m[1])
  const version = Number(m[2])
  const known = artifacts.find(a => a.id === id)
  const title =
    known?.title ?? (typeof entry.input.title === 'string' ? entry.input.title : `Artifact ${id}`)
  return { id, version, title }
}

export interface RowContext {
  pending: PermissionRequest[]
  streaming: string[]
  /** A live handle that is working: a tool with no result is still running. */
  running: boolean
  artifacts: SessionDetail['artifacts']
}

export function toolCallView(
  entry: ToolEntry,
  ctx: Pick<RowContext, 'pending' | 'running'>,
  children: ToolCallView[] = [],
): ToolCallView {
  // A result the user refused or stopped is neutral ("Denied" / "Stopped"), never a tool failure.
  const userStatus = entry.result?.status
  const status: ToolCallView['status'] = entry.result
    ? userStatus
      ? 'cancelled'
      : entry.result.ok
        ? 'ok'
        : 'failed'
    : ctx.pending.some(p => p.toolUseId === entry.id)
      ? 'awaiting'
      : ctx.running
        ? 'running'
        : 'cancelled'
  return {
    id: entry.id,
    name: entry.name,
    input: entry.input,
    status,
    ...(userStatus ? { statusText: userStatus === 'denied' ? 'Denied' : 'Stopped' } : {}),
    ...(entry.result
      ? { result: { text: entry.result.text, truncated: entry.result.truncated } }
      : {}),
    ...(children.length ? { children } : {}),
  }
}

/** Task lifecycle describes the process, independently of a successful launch tool. */
function withTask(call: ToolCallView, task: TaskActivity): ToolCallView {
  return {
    ...call,
    status: taskStatus(task.state),
    statusText: taskStateLabel(task),
    ...(task.kind === 'command'
      ? {
          result: task.output
            ? { text: task.output.text, truncated: task.output.truncated }
            : undefined,
        }
      : {}),
  }
}

/** Standalone task labels can be descriptions, so never invent executable command text. */
export function commandTaskView(task: TaskActivity): ToolCallView {
  return withTask({ id: taskKey(task), name: 'Terminal', input: {}, status: 'idle' }, task)
}

/**
 * The thread's rows. Tool calls whose `parentToolUseId` names another tool call nest under it (a subagent's work
 * under its Agent/Task call); a subagent's own text and thinking stay inside it (its result carries the summary).
 * `head` marks the first row of a run by the same author, where the avatar and name go.
 */
export function buildRows(entries: TranscriptEntry[], ctx: RowContext): Row[] {
  const tasks = entries.flatMap(e => (e.kind === 'task' ? [e.task] : []))
  const toolIds = new Set(entries.filter(e => e.kind === 'tool').map(e => e.id))
  const childrenOf = new Map<string, ToolEntry[]>()
  for (const e of entries) {
    if (e.kind === 'tool' && e.parentToolUseId && toolIds.has(e.parentToolUseId)) {
      const list = childrenOf.get(e.parentToolUseId) ?? []
      list.push(e)
      childrenOf.set(e.parentToolUseId, list)
    }
  }
  const viewOf = (e: ToolEntry, seen: Set<string>): ToolCallView => {
    seen.add(e.id)
    const kids = (childrenOf.get(e.id) ?? []).filter(k => !seen.has(k.id))
    const call = toolCallView(
      e,
      ctx,
      kids.map(k => viewOf(k, seen)),
    )
    const task = [...tasks].reverse().find(t => t.toolUseId === e.id)
    return task ? withTask(call, task) : call
  }

  const rows: Row[] = []
  let author: 'user' | 'assistant' | null = null
  for (const e of entries) {
    // nested work renders inside its parent call
    if (e.kind !== 'task' && e.parentToolUseId && toolIds.has(e.parentToolUseId)) continue
    switch (e.kind) {
      case 'user':
        rows.push({ kind: 'user', id: e.id, entry: e, head: author !== 'user' })
        author = 'user'
        break
      case 'assistant':
      case 'thinking': {
        const streaming = ctx.streaming.includes(e.id)
        if (e.kind === 'assistant')
          rows.push({
            kind: 'assistant',
            id: e.id,
            entry: e,
            head: author !== 'assistant',
            streaming,
          })
        else
          rows.push({
            kind: 'thinking',
            id: e.id,
            entry: e,
            head: author !== 'assistant',
            streaming,
          })
        author = 'assistant'
        break
      }
      case 'tool': {
        const task = [...tasks].reverse().find(t => t.toolUseId === e.id)
        const call = viewOf(e, new Set())
        const nestedIds = new Set<string>()
        const collect = (children: ToolCallView[]) => {
          for (const child of children) {
            nestedIds.add(child.id)
            collect(child.children ?? [])
          }
        }
        collect(call.children ?? [])
        const commandTasks = tasks.filter(
          task => task.kind === 'command' && task.toolUseId && nestedIds.has(task.toolUseId),
        )
        rows.push({
          kind: 'tool',
          id: e.id,
          call,
          head: author !== 'assistant',
          artifact: artifactRef(e, ctx.artifacts),
          ...(task ? { task } : {}),
          ...(commandTasks.length ? { commandTasks } : {}),
        })
        author = 'assistant'
        break
      }
      case 'system':
        rows.push({ kind: 'system', id: e.id, entry: e })
        author = null
        break
      case 'injected':
        rows.push({ kind: 'injected', id: e.id, entry: e })
        author = null
        break
      case 'task':
        if (
          e.task.toolUseId &&
          entries.some(
            tool =>
              tool.kind === 'tool' &&
              tool.id === e.task.toolUseId &&
              (e.task.kind === 'command' || !tool.parentToolUseId),
          )
        )
          break
        rows.push({ kind: 'task', id: e.id, task: e.task, head: author !== 'assistant' })
        author = 'assistant'
        break
    }
  }
  return rows
}

// ── side panel ────────────────────────────────────────────────────────────────

const FILE_TOOLS = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'search_replace',
  'write',
  'write_file',
])

export interface ChangedFile {
  path: string
  /** Edit/Write calls on it. */
  edits: number
  /** Whether the latest of them failed. */
  failed: boolean
}

/** Files the session wrote, from its Edit/Write/MultiEdit/NotebookEdit calls, in first-touched order. */
export function filesChanged(entries: TranscriptEntry[]): ChangedFile[] {
  const out = new Map<string, ChangedFile>()
  for (const e of entries) {
    if (e.kind !== 'tool' || !FILE_TOOLS.has(e.name)) continue
    const path = e.input.file_path ?? e.input.target_file ?? e.input.notebook_path ?? e.input.path
    if (typeof path !== 'string' || !path) continue
    const cur = out.get(path)
    const failed = e.result ? !e.result.ok && !e.result.status : false
    out.set(path, { path, edits: (cur?.edits ?? 0) + 1, failed })
  }
  return [...out.values()]
}

/** Context window for a model: 1M for the long-context variants, else 200k. */
export function contextWindow(model: string | null): number {
  return model && /\[1m\]|-1m\b/i.test(model) ? 1_000_000 : 200_000
}

// ── prompts ───────────────────────────────────────────────────────────────────

type Question = NonNullable<PermissionPromptRequest['questions']>[number]

function parseQuestions(raw: unknown): Question[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: Question[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const r = q as Record<string, unknown>
    if (typeof r.question !== 'string') continue
    const options = Array.isArray(r.options)
      ? r.options
          .map(o => {
            if (typeof o === 'string') return { label: o }
            const ro = (o ?? {}) as Record<string, unknown>
            return typeof ro.label === 'string'
              ? {
                  label: ro.label,
                  ...(typeof ro.description === 'string' ? { description: ro.description } : {}),
                }
              : null
          })
          .filter((o): o is { label: string; description?: string } => o !== null)
      : []
    out.push({
      ...(typeof r.id === 'string' ? { id: r.id } : {}),
      question: r.question,
      header: typeof r.header === 'string' ? r.header : '',
      ...(r.multiSelect === true ? { multiSelect: true } : {}),
      options,
    })
  }
  return out
}

function editDiff(toolName: string, input: Record<string, unknown>): DiffHunk[] | undefined {
  if (Array.isArray(input.changes)) {
    const hunks: DiffHunk[] = []
    for (const change of input.changes) {
      if (!change || typeof change.diff !== 'string') continue
      let current: DiffHunk | undefined
      let oldNum = 0
      let newNum = 0
      for (const line of change.diff.split('\n')) {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
        if (header) {
          oldNum = Number(header[1])
          newNum = Number(header[2])
          current = { header: `${String(change.path ?? '')} ${line}`, lines: [] }
          hunks.push(current)
        } else if (current && line.startsWith('+'))
          current.lines.push({ type: 'add', content: line.slice(1), newNum: newNum++ })
        else if (current && line.startsWith('-'))
          current.lines.push({ type: 'remove', content: line.slice(1), oldNum: oldNum++ })
        else if (current && line.startsWith(' '))
          current.lines.push({
            type: 'context',
            content: line.slice(1),
            oldNum: oldNum++,
            newNum: newNum++,
          })
      }
    }
    if (hunks.length) return hunks
  }
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null)
  if (toolName === 'Edit' || toolName === 'search_replace') {
    const before = str('old_string')
    const after = str('new_string')
    return before !== null && after !== null ? diffLines(before, after) : undefined
  }
  if (toolName === 'Write' || toolName === 'write' || toolName === 'write_file') {
    const content = str('content')
    return content !== null ? diffLines('', content) : undefined
  }
  if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
    const hunks: DiffHunk[] = []
    for (const ed of input.edits) {
      const r = (ed ?? {}) as Record<string, unknown>
      if (typeof r.old_string === 'string' && typeof r.new_string === 'string')
        hunks.push(...diffLines(r.old_string, r.new_string))
    }
    return hunks.length ? hunks : undefined
  }
  return undefined
}

/** A harness prompt as IuPermissionPrompt shows it. Title and description stay plain text. */
export function toPromptRequest(req: PermissionRequest): PermissionPromptRequest {
  const fallbackTitle =
    req.kind === 'plan'
      ? 'The agent has a plan for you to review'
      : req.kind === 'question'
        ? 'The agent has a question'
        : `The agent wants to use ${req.toolName}`
  const plan =
    req.kind === 'plan' && typeof req.input.plan === 'string' ? req.input.plan : undefined
  const questions = req.kind === 'question' ? parseQuestions(req.input.questions) : undefined
  const diff = req.kind === 'tool' ? editDiff(req.toolName, req.input) : undefined
  return {
    id: req.id,
    kind: req.kind,
    tool: req.toolName,
    title: req.title ?? fallbackTitle,
    ...(req.description ? { description: req.description } : {}),
    input: req.input,
    ...(diff ? { diff } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(questions ? { questions } : {}),
    canAlwaysAllow: req.canAlwaysAllow,
    defaultToDeny: req.defaultToDeny,
  }
}

/** The prompt's answer as the API takes it. Question answers go into `updatedInput` next to the questions. */
export function toPermissionAnswer(
  answer: PermissionPromptAnswer,
  req: PermissionRequest,
): PermissionAnswer {
  if (answer.behavior === 'deny')
    return answer.message ? { behavior: 'deny', message: answer.message } : { behavior: 'deny' }
  return {
    behavior: 'allow',
    scope: answer.scope,
    ...(answer.answers ? { updatedInput: { ...req.input, answers: answer.answers } } : {}),
  }
}

// ── composer ──────────────────────────────────────────────────────────────────

/** What the composer may do in a state. */
export function composerMode(
  state: SessionState,
  sending: boolean,
): { disabled: boolean; queued: boolean; reason: string | null } {
  if (state === 'waiting')
    return { disabled: true, queued: false, reason: 'Answer the prompt above to continue.' }
  if (sending) return { disabled: true, queued: false, reason: null }
  if (state === 'running')
    return {
      disabled: false,
      queued: true,
      reason: 'The agent is working: a message you send now is queued for after the current turn.',
    }
  if (state === 'ended' || state === 'failed')
    return { disabled: false, queued: false, reason: 'Sending a message resumes the session.' }
  return { disabled: false, queued: false, reason: null }
}

export const PERMISSION_MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: 'Ask before acting' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan only' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't ask" },
  { value: 'bypassPermissions', label: 'Bypass permissions' },
]
