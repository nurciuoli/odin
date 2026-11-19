// Perches for Home: what each in-progress session is doing and how lively it is, derived on the client from what the
// API already gives (transcript entry timestamps, open prompts, task entries) plus the live frames that arrive while
// Home is open.
import type { RouteLocationRaw } from 'vue-router'
import type { SessionDetail } from '@odin/shared/api'
import type { PermissionRequest, TranscriptEntry } from '@odin/shared/harness'
import type { FlockState } from '@/components/Spinner'
import { SESSION_DISPLAY } from './format'
import { describeWork, workTotal, type WorkCount } from '@/app/backgroundWork'

export const MINUTE = 60_000
/** A running session with nothing new for this long reads as quiet. */
export const QUIET_AFTER = 2 * MINUTE

/** One in-progress session as a row: a flock, what it's doing, and the state in words. */
export interface Perch {
  id: string
  title: string
  /** Where the title links (the session). */
  to: RouteLocationRaw
  /** What it's doing now, one line ("Editing ArtifactPanel.vue", "Wants to run npm test"). */
  activity: string
  /** paused = waiting for the user (the only amber state). */
  state: 'running' | 'quiet' | 'paused'
  /** How the flock behaves for that state. */
  flock: Extract<FlockState, 'working' | 'quiet' | 'waiting'>
  /** The state in words, always shown beside the flock: "Running", "Running · quiet 4m", "Needs you 6m". */
  word: string
  /** The same at more length, for assistive tech ("Started 12 minutes ago, paused for the last 4 minutes"). */
  description: string
  /** Subagents out right now. */
  agents: number
}

export interface PerchInput {
  now: number
  /** When the session started (ISO). */
  startedAt: string
  /** Moments of activity (entry timestamps, ms since epoch). */
  times: number[]
  /** When it began waiting on the user, while it waits (the oldest open prompt). */
  pausedSince: number | null
}

/** The latest moment of activity that isn't in the future; the session's start when nothing was recorded. */
export function lastActivity(input: PerchInput): number {
  let last = Date.parse(input.startedAt)
  if (Number.isNaN(last)) last = -Infinity
  for (const t of input.times) if (t <= input.now && t > last) last = t
  return Number.isFinite(last) ? last : input.now
}

/** How long a running session has had nothing new, once that is long enough to say; null while it is lively or paused. */
export function quietFor(input: PerchInput): number | null {
  if (input.pausedSince !== null) return null
  const gap = input.now - lastActivity(input)
  return gap >= QUIET_AFTER ? gap : null
}

/** "4m", "1h 5m": whole minutes, for the state word. */
export function shortDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / MINUTE))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`
}

export function perchWord(input: PerchInput): string {
  if (input.pausedSince !== null) {
    const paused = input.now - input.pausedSince
    const word = SESSION_DISPLAY.waiting.label
    return paused >= MINUTE ? `${word} ${shortDuration(paused)}` : word
  }
  const quiet = quietFor(input)
  const running = SESSION_DISPLAY.running.label
  return quiet === null ? running : `${running} · quiet ${shortDuration(quiet)}`
}

/** A perch's word split into the state label and what follows it ("Needs you" + "2m", "Running" + "quiet 4m"). */
export function perchParts(p: Pick<Perch, 'word' | 'state'>): { word: string; since: string } {
  const word = SESSION_DISPLAY[p.state === 'paused' ? 'waiting' : 'running'].label
  return { word, since: p.word.slice(word.length).replace(/^\s*·?\s*/, '') }
}

const minutesText = (n: number) => `${n} minute${n === 1 ? '' : 's'}`

/** The row's state in a sentence, for its accessible description. */
export function perchDescription(input: PerchInput): string {
  const start = Date.parse(input.startedAt)
  const age = Math.max(0, Math.round((input.now - start) / MINUTE)) || 0
  const long = age >= 60
  const started = long ? 'Started over an hour ago' : `Started ${minutesText(age)} ago`
  if (input.pausedSince !== null) {
    const paused = Math.max(0, Math.round((input.now - input.pausedSince) / MINUTE))
    return `${started}, paused for ${paused < 1 ? 'under a minute' : `the last ${minutesText(paused)}`}`
  }
  const quiet = quietFor(input)
  if (quiet !== null)
    return `${started}, quiet for the last ${minutesText(Math.floor(quiet / MINUTE))}`
  return long ? `${started}, active since` : `Active for ${minutesText(age)}`
}

/**
 * Subagents running now: agent tasks the harness reports as running, plus Agent/Task tool calls still without a
 * result that no task entry speaks for.
 */
export function runningAgents(entries: TranscriptEntry[]): number {
  const spoken = new Set<string>()
  let n = 0
  for (const e of entries) {
    if (e.kind !== 'task' || e.task.kind !== 'agent') continue
    if (e.task.toolUseId) spoken.add(e.task.toolUseId)
    if (e.task.state === 'running') n++
  }
  for (const e of entries)
    if (
      e.kind === 'tool' &&
      (e.name === 'Agent' || e.name === 'Task' || e.name === 'spawn_subagent') &&
      !e.result
    )
      if (!spoken.has(e.id)) n++
  return n
}

/** Every timestamp in a transcript, nested work included. */
export function transcriptTimes(entries: TranscriptEntry[]): number[] {
  const out: number[] = []
  for (const e of entries) {
    if (!e.at) continue
    const t = Date.parse(e.at)
    if (!Number.isNaN(t)) out.push(t)
  }
  return out
}

const base = (p: unknown) => (typeof p === 'string' ? (p.split('/').pop() ?? p) : '')
/** Home shows the command family; full arguments remain in the session's tool output. */
function commandActivity(command: unknown): string {
  if (typeof command !== 'string') return 'Running a command'
  const executable = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/)
  const name = (executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.(?:exe|cmd|bat)$/i, '')
    .toLowerCase()
  if (name === 'powershell' || name === 'pwsh') return 'Running PowerShell command'
  if (name === 'bash' || name === 'sh' || name === 'zsh') return 'Running shell command'
  if (name === 'cmd') return 'Running Windows command'
  return name ? `Running ${name} command` : 'Running a command'
}
const oneLine = (s: string, max = 80) => {
  const line =
    s
      .split('\n')
      .find(l => l.trim())
      ?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A prompt as a short clause: "Wants to run npm test", "Asks: header too?". */
export function promptActivity(p: PermissionRequest): string {
  if (p.kind === 'question') {
    const qs = p.input.questions
    const first = Array.isArray(qs) ? (qs[0] as { question?: unknown } | undefined) : undefined
    return typeof first?.question === 'string'
      ? `Asks: ${oneLine(first.question)}`
      : 'Has a question'
  }
  if (p.kind === 'plan') return 'Has a plan for you to review'
  if (typeof p.input.command === 'string') return `Wants to run ${oneLine(p.input.command)}`
  const file = base(p.input.file_path ?? p.input.path)
  if (file) return `Wants to edit ${file}`
  return p.title ? oneLine(p.title) : `Wants to use ${p.toolName}`
}

function toolActivity(e: Extract<TranscriptEntry, { kind: 'tool' }>): string {
  const i = e.input
  switch (e.name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `Editing ${base(i.file_path ?? i.notebook_path ?? i.path)}`
    case 'Read':
      return `Reading ${base(i.file_path ?? i.path)}`
    case 'Bash':
    case 'run_terminal_command':
    case 'exec_command':
      return commandActivity(i.command ?? i.cmd)
    case 'Grep':
    case 'Glob':
      return typeof i.pattern === 'string' ? `Searching ${oneLine(i.pattern)}` : 'Searching'
    case 'TodoWrite':
      return 'Updating the plan'
    case 'Task':
    case 'Agent':
    case 'spawn_subagent':
      return typeof i.description === 'string'
        ? `Delegating: ${oneLine(i.description)}`
        : 'Delegating'
    default:
      return `Using ${e.name.replace(/^mcp__([^_]+)__/, '$1 › ')}`
  }
}

/** The row's one-line "now": the open prompt, else the latest tool call or reply. */
export function laneActivity(detail: Pick<SessionDetail, 'pending' | 'transcript'>): string {
  const prompt = detail.pending[0]
  if (prompt) return promptActivity(prompt)
  for (let i = detail.transcript.length - 1; i >= 0; i--) {
    const e = detail.transcript[i]!
    if (e.kind === 'tool') return toolActivity(e)
    if (e.kind === 'assistant' && e.text.trim()) return oneLine(e.text)
    if (e.kind === 'user') return 'Reading your message'
  }
  return 'Starting'
}

export interface LaneSource {
  detail: Pick<
    SessionDetail,
    'id' | 'title' | 'state' | 'createdAt' | 'pending' | 'transcript' | 'waitingFor'
  >
  /** Activity seen live that the transcript may not timestamp. */
  extraTimes?: number[]
  /** Subagents and commands still running after the turn ended: they are what the row says it's doing. */
  work?: WorkCount
}

export function buildPerch(src: LaneSource, now: number): Perch {
  const d = src.detail
  const oldest = d.pending.length
    ? Math.min(...d.pending.map(p => Date.parse(p.createdAt)).filter(t => !Number.isNaN(t)))
    : NaN
  const pausedSince = d.state === 'waiting' ? (Number.isFinite(oldest) ? oldest : now) : null
  const input: PerchInput = {
    now,
    startedAt: d.createdAt,
    times: [...transcriptTimes(d.transcript), ...(src.extraTimes ?? [])],
    pausedSince,
  }
  const state = pausedSince !== null ? 'paused' : quietFor(input) !== null ? 'quiet' : 'running'
  const agents = state === 'paused' ? 0 : runningAgents(d.transcript)
  return {
    id: d.id,
    title: d.title,
    to: { name: 'session', params: { id: d.id } },
    activity: workTotal(src.work) ? describeWork(src.work!) : laneActivity(d),
    state,
    flock: state === 'paused' ? 'waiting' : state === 'quiet' ? 'quiet' : 'working',
    word: perchWord(input),
    description: agents
      ? `${perchDescription(input)}, ${agents} subagent${agents === 1 ? '' : 's'} out`
      : perchDescription(input),
    agents,
  }
}
