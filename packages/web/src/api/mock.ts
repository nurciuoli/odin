// The mock Api: every method over in-memory fixtures. Mutations change the fixtures and emit the same ServerEvents core
// would, so screens that listen to `subscribe` behave the same on mock data. Started sessions and sent messages get a
// scripted reply (streamed text; a permission prompt when the message mentions "run" or "delete") so the Session
// screen can be built and demoed without a server.
import type {
  FileMatch,
  FileSearchResult,
  AssetFiles,
  AssetKind,
  ImportPreview,
  Installation,
  PluginMemberKind,
  PluginPreview,
  PluginRun,
  LibraryAsset,
  MetricsDimension,
  MetricsQuery,
  MetricsRow,
  PermissionAnswer,
  ProjectDetail,
  ProjectSummary,
  Session,
  SessionDetail,
  SessionFilter,
  MessageQueue,
  UserMessage,
  ShellRunResult,
} from '@odin/shared/api'
import { emptyProjectContext, parseProjectSources } from '@odin/shared/api'
import type { HarnessEvent, PermissionRequest, SlashCommand } from '@odin/shared/harness'
import type { ServerEvent } from '@odin/shared/events'
import {
  ASSET_ID_PATTERN,
  LIBRARY_KINDS,
  fillPrompt,
  isInstallable,
  libraryAgentId,
  promptVariables,
} from '@odin/shared/library'
import { PROJECT_NAME_PATTERN } from '@odin/shared/labels'
import { SECRET_NAME_PATTERN, secretRefs } from '@odin/shared/library'
import { normaliseModel } from '@odin/shared/pricing'
import { applyHarnessEvent, toolResult } from '@odin/shared/transcript'
import { emptyMetrics, LOW_CONFIDENCE_N, sessionBranch, slugify } from '@odin/shared/session'
import type { Api } from './types'
import { MOCK_FILE_MAP, mockFileText } from './mock.filemap'
import { createFixtures, fakeHash, fakeUuid, localDay, type Fixtures } from './fixtures'
import { ApiRequestError } from './types'
import { mockNotebooks } from './mock-notebooks'

export interface MockApiOptions {
  /** Simulated round trip in ms. 0 resolves on the next microtask (tests). */
  latency?: number
  fixtures?: Fixtures
  /**
   * Delay before the scripted assistant starts answering (ms). Off (null) unless set, or unless `latency` is above
   * zero, so tests that send a message don't get a reply they didn't ask for.
   */
  replyDelayMs?: number | null
}

/** The mock plus the handles tests and screens-in-development use to poke it. */
export interface MockApi extends Api {
  db: Fixtures
  emit(event: ServerEvent): void
  /** Push a harness event into a session as if the harness sent it (updates transcript, pending, state). */
  harnessEvent(sessionId: string, event: HarnessEvent): void
}

const UNKNOWN = '∅'
/** What a Claude session's `init` lists, roughly: enough for the composer's `/` menu. */
const MOCK_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'compact',
    description: 'Clear history but keep a summary in context',
    argumentHint: '<instructions>',
    source: 'builtin',
  },
  {
    name: 'review',
    description: 'Review code changes',
    argumentHint: '',
    source: 'builtin',
    choices: [
      { label: 'Uncommitted changes', insert: '' },
      { label: 'Against a base branch', insert: 'branch ', hint: '<branch>' },
      { label: 'A commit', insert: 'commit ', hint: '<sha>' },
      { label: 'Custom instructions', insert: 'custom ', hint: '<instructions>' },
    ],
  },
  {
    name: 'init',
    description: 'Write a CLAUDE.md for this codebase',
    argumentHint: '',
    source: 'builtin',
  },
  {
    name: 'security-review',
    description: 'Security review of the pending changes',
    argumentHint: '',
    source: 'builtin',
  },
  {
    name: 'pr-comments',
    description: 'Fetch comments from a GitHub pull request',
    argumentHint: '<pr>',
    aliases: ['prc'],
    source: 'custom',
  },
  {
    name: 'write-plan',
    description: 'Library skill: write an implementation plan',
    argumentHint: '<goal>',
    source: 'library',
  },
]

/** Fuzzy path match for the mock `@` search: query characters in order, contiguous and basename hits first. */
export function fuzzyMatchPaths(paths: FileMatch[], query: string, limit = 50): FileMatch[] {
  const q = query.toLowerCase()
  const scored: { m: FileMatch; score: number }[] = []
  for (const m of paths) {
    const p = m.path.toLowerCase()
    let i = 0
    for (const ch of p) if (i < q.length && ch === q[i]) i++
    if (i < q.length) continue
    const base = p.slice(p.lastIndexOf('/') + 1)
    const score = !q ? 0 : base.startsWith(q) ? 0 : p.includes(q) ? 1 : 2
    scored.push({ m, score: score * 1000 + p.length })
  }
  return scored
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(s => s.m)
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}
const rate = (yes: number, of: number): number | null => (of ? yes / of : null)
const known = (xs: (number | null | undefined)[]): number[] =>
  xs.filter((x): x is number => typeof x === 'number')

function dimensionKey(s: Session, dim: MetricsDimension): string {
  switch (dim) {
    case 'model':
      return s.model ? normaliseModel(s.model) : UNKNOWN
    case 'agent':
      return s.agent ?? UNKNOWN
    case 'agentVersion':
      return s.agent && s.agentVersion ? `${s.agent}@${s.agentVersion.slice(0, 8)}` : UNKNOWN
    case 'template':
      return s.templateId ?? UNKNOWN
    case 'harness':
      return s.harness
    case 'project':
      return s.project
    case 'origin':
      return s.origin
  }
}

/** docs/contracts.md#metrics over the given sessions. Pure, so tests can feed it a small set. */
export function computeMetrics(sessions: Session[], q: MetricsQuery): MetricsRow[] {
  if (q.groupBy.length > 3 || new Set(q.groupBy).size !== q.groupBy.length) {
    throw new ApiRequestError(400, 'groupBy takes 0–3 distinct dimensions')
  }
  const pop = sessions.filter(
    s =>
      s.metrics.turns > 0 &&
      !s.archived &&
      (!q.project || s.project === q.project) &&
      (!q.since || s.updatedAt >= q.since) &&
      (!q.until || s.createdAt < q.until),
  )
  const groups = new Map<string, Session[]>()
  // no grouping: exactly one row over the whole population, even an empty one
  if (!q.groupBy.length) groups.set('[]', [])
  for (const s of pop) {
    const key = JSON.stringify(q.groupBy.map(d => dimensionKey(s, d)))
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const rows: MetricsRow[] = []
  for (const [key, group] of groups) {
    const values = JSON.parse(key) as string[]
    const withPr = group.filter(s => s.metrics.prOutcome && s.metrics.prOutcome !== 'open')
    const merged = withPr.filter(
      s => s.metrics.prOutcome === 'merged' || s.metrics.prOutcome === 'merged-after-changes',
    )
    rows.push({
      key: Object.fromEntries(q.groupBy.map((d, i) => [d, values[i]!])),
      n: group.length,
      lowConfidence: group.length < LOW_CONFIDENCE_N,
      median: {
        wallMs: median(known(group.map(s => s.metrics.wallMs))),
        activeMs: median(known(group.map(s => s.metrics.activeMs))),
        turns: median(group.map(s => s.metrics.turns)),
        toolCalls: median(group.map(s => s.metrics.toolCalls)),
        tokensOut: median(group.map(s => s.metrics.tokens.output)),
        costUsd: median(known(group.map(s => s.metrics.costUsd))),
        diffLines: median(
          known(
            group.map(s => (s.metrics.diff ? s.metrics.diff.added + s.metrics.diff.removed : null)),
          ),
        ),
      },
      rates: {
        merged: rate(merged.length, withPr.length),
        mergedClean: rate(
          withPr.filter(s => s.metrics.prOutcome === 'merged').length,
          withPr.length,
        ),
        failed: rate(group.filter(s => s.state === 'failed').length, group.length),
      },
      total: {
        tokens: {
          input: group.reduce((a, s) => a + s.metrics.tokens.input, 0),
          output: group.reduce((a, s) => a + s.metrics.tokens.output, 0),
          cacheRead: group.reduce((a, s) => a + s.metrics.tokens.cacheRead, 0),
          cacheWrite: group.reduce((a, s) => a + s.metrics.tokens.cacheWrite, 0),
        },
        costUsd: known(group.map(s => s.metrics.costUsd)).length
          ? known(group.map(s => s.metrics.costUsd)).reduce((a, c) => a + c, 0)
          : null,
      },
      sessionIds: group.map(s => s.id),
    })
  }
  return rows.sort(
    (a, b) => b.n - a.n || JSON.stringify(a.key).localeCompare(JSON.stringify(b.key)),
  )
}

function matches(s: Session, f: SessionFilter, firstPrompt: string): boolean {
  if (f.project && !(s.projects ?? [s.project]).includes(f.project)) return false
  if (f.state?.length && !f.state.includes(s.state)) return false
  if (f.tag && !s.tags.includes(f.tag)) return false
  if (f.model && (!s.model || normaliseModel(s.model) !== normaliseModel(f.model))) return false
  if (f.origin && s.origin !== f.origin) return false
  if (f.archived !== undefined && s.archived !== f.archived) return false
  if (f.pinned !== undefined && s.pinned !== f.pinned) return false
  // Side threads stay out unless asked for: `parentId` lists every fork of a session (side threads included),
  // otherwise `aside: true` lists only side threads and anything else leaves them out.
  if (f.parentId !== undefined) {
    if (s.parentId !== f.parentId) return false
  } else if (s.aside !== (f.aside === true)) return false
  if (f.since && s.updatedAt < f.since) return false
  if (f.q) {
    const q = f.q.toLowerCase()
    if (!s.title.toLowerCase().includes(q) && !firstPrompt.toLowerCase().includes(q)) return false
  }
  return true
}

export function createMockApi(options: MockApiOptions = {}): MockApi {
  const db = options.fixtures ?? createFixtures()
  const latency = options.latency ?? 0
  const replyDelay =
    options.replyDelayMs !== undefined ? options.replyDelayMs : latency > 0 ? 600 : null
  const listeners = new Set<(e: ServerEvent) => void>()
  const clone = <T>(v: T): T => structuredClone(v)
  const wait = () => (latency > 0 ? new Promise(r => setTimeout(r, latency)) : Promise.resolve())
  const respond = async <T>(fn: () => T): Promise<T> => {
    await wait()
    return clone(fn())
  }
  const nowIso = () => new Date().toISOString()
  let seq = 0
  const queues = new Map<string, MessageQueue>()
  const releasing = new Set<string>()
  const pauseAfter = new Set<string>()
  const messageKeys = new Map<string, Map<string, string>>()
  const queueOf = (id: string): MessageQueue => {
    sessionOf(id)
    let queue = queues.get(id)
    if (!queue) queues.set(id, (queue = { revision: 0, paused: false, messages: [] }))
    return queue
  }
  function queueChanged(id: string) {
    const queue = queueOf(id)
    queue.revision++
    emit({ type: 'session.queue', sessionId: id, queue })
    return queue
  }
  function pumpQueue(id: string) {
    const queue = queueOf(id)
    const session = sessionOf(id)
    if (
      queue.paused ||
      session.state === 'running' ||
      session.state === 'waiting' ||
      queue.messages.some(m => m.state !== 'queued')
    )
      return
    const next = queue.messages[0]
    if (!next) return
    next.state = 'sending'
    next.updatedAt = nowIso()
    queueChanged(id)
    userTurn(id, next.message)
    if (pauseAfter.delete(id)) {
      queue.paused = true
      queueChanged(id)
    }
  }
  /** True when the message is now first in the queue. A finished duplicate is left as it is. */
  function placeNext(id: string, message: UserMessage): boolean {
    const keys = messageKeys.get(id) ?? new Map<string, string>()
    if (message.clientId && keys.has(message.clientId)) {
      if (keys.get(message.clientId) !== JSON.stringify(message))
        throw new ApiRequestError(409, 'message id already used for different content')
      const queue = queueOf(id)
      const existing = queue.messages.find(m => m.message.clientId === message.clientId)
      if (!existing || existing.state !== 'queued') return false
      queue.messages = [existing, ...queue.messages.filter(m => m !== existing)]
      queueChanged(id)
      return true
    }
    if (!message.text.trim() && !message.attachments?.length) bad('empty message')
    if (message.clientId) {
      keys.set(message.clientId, JSON.stringify(message))
      messageKeys.set(id, keys)
    }
    const queue = queueOf(id)
    queue.messages.unshift({
      id: message.clientId ?? `queue-${++seq}`,
      message: clone(message),
      state: 'queued',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    queueChanged(id)
    return true
  }
  function editableMessage(id: string, messageId: string) {
    const message = queueOf(id).messages.find(m => m.id === messageId) ?? notFound('queued message')
    if (message.state !== 'queued')
      throw new ApiRequestError(409, 'message has already been dispatched')
    return message
  }

  function emit(event: ServerEvent) {
    for (const l of listeners) l(clone(event))
  }

  const notFound = (what: string): never => {
    throw new ApiRequestError(404, `${what} not found`)
  }
  const projectOf = (name: string) =>
    db.projects.find(p => p.name === name) ?? notFound(`project ${name}`)
  const sessionOf = (id: string) => db.sessions.find(s => s.id === id) ?? notFound(`session ${id}`)
  // vault and MCP sign-in, kept in memory
  const HOUR_MS = 3_600_000
  const fromNow = (ms: number) => new Date(Date.now() + ms).toISOString()
  const secrets = new Map<string, { createdAt: string; updatedAt: string }>([
    ['GITHUB_TOKEN', { createdAt: fromNow(-72 * HOUR_MS), updatedAt: fromNow(-24 * HOUR_MS) }],
  ])
  const signedIn = new Set<string>(['docs'])
  const secretUsers = () => {
    const users = new Map<string, string[]>()
    for (const a of db.library.filter(x => x.kind === 'mcp' && !x.error)) {
      for (const name of new Set(secretRefs(JSON.stringify(a.meta)))) {
        users.set(name, [...(users.get(name) ?? []), a.id])
      }
    }
    return users
  }
  const oauthServer = (id: string) => {
    const a = db.library.find(x => x.kind === 'mcp' && x.id === id)
    if (!a) return notFound(`mcp ${id}`)
    if (!(a.meta as { oauth?: unknown }).oauth)
      throw new ApiRequestError(400, `MCP server ${id} has no oauth setting`)
    return a
  }

  const pendingImports = new Map<string, ImportPreview>()
  function pluginPreview(project: string, asset: LibraryAsset): PluginPreview {
    const meta = asset.meta as {
      includes?: { kind: PluginMemberKind; id: string }[]
      own?: { kind: PluginMemberKind; id: string }[]
    }
    const files = db.libraryFiles[`plugin/${asset.id}`] ?? {}
    const runs: PluginRun[] = []
    for (const [path, text] of Object.entries(files)) {
      if (path.startsWith('settings/'))
        for (const [event, v] of Object.entries(
          (JSON.parse(text) as { hooks?: Record<string, unknown> }).hooks ?? {},
        ))
          runs.push({
            kind: 'hook',
            member: `settings/${path.slice(9, -5)}`,
            text: `${event}: ${JSON.stringify(v)}`,
          })
      if (path.startsWith('mcp/')) {
        const spec = JSON.parse(text) as { type?: string; command?: string; url?: string }
        runs.push(
          spec.command
            ? { kind: 'command', member: `mcp/${path.slice(4, -5)}`, text: spec.command }
            : { kind: 'remote', member: `mcp/${path.slice(4, -5)}`, text: spec.url ?? '' },
        )
      }
    }
    const secretNames = [...new Set(Object.values(files).flatMap(secretRefs))]
    return {
      project,
      plugin: asset.id,
      version: asset.version,
      members: [
        ...(meta.own ?? []).map(m => ({ ...m, origin: 'own' as const, version: asset.version })),
        ...(meta.includes ?? []).map(m => ({
          ...m,
          origin: 'library' as const,
          version: db.library.find(a => a.kind === m.kind && a.id === m.id)?.version ?? '',
        })),
      ],
      runs,
      missing: (meta.includes ?? [])
        .filter(m => !db.library.some(a => a.kind === m.kind && a.id === m.id))
        .map(m => `${m.kind}/${m.id}`),
      secrets: secretNames.map(name => ({ name, set: secrets.has(name) })),
      oauth: [],
      confirm: runs.some(r => r.kind !== 'remote')
        ? fakeHash(JSON.stringify(runs)).slice(0, 16)
        : null,
    }
  }
  const assetOf = (kind: AssetKind, id: string) =>
    db.library.find(a => a.kind === kind && a.id === id) ?? notFound(`${kind} ${id}`)

  function summary(p: ProjectDetail): ProjectSummary {
    const own = db.sessions.filter(
      s => (s.projects ?? [s.project]).includes(p.name) && !s.archived && !s.aside,
    )
    const {
      settings: _s,
      manifestError: _m,
      git: _g,
      status: _st,
      agents: _a,
      dirtyFiles: _d,
      context: _c,
      ...rest
    } = p
    return {
      ...rest,
      sessions: {
        running: own.filter(s => s.state === 'running').length,
        waiting: own.filter(s => s.state === 'waiting').length,
        total: own.length,
      },
    }
  }
  const bad = (msg: string): never => {
    throw new ApiRequestError(400, msg)
  }
  const detail = (p: ProjectDetail): ProjectDetail => ({ ...p, ...summary(p) })

  function touch(s: Session, patch: Partial<Session> = {}) {
    Object.assign(s, patch, { updatedAt: nowIso() })
    emit({ type: 'session.updated', session: s })
    emit({ type: 'project.updated', project: s.project })
  }

  /** Applies a harness event the way core's sessions service does, then forwards it. */
  const streamingBySession = new Map<string, Set<string>>()
  function harnessEvent(sessionId: string, event: HarnessEvent) {
    const s = sessionOf(sessionId)
    if (event.type === 'delta') {
      const entryId = event.entryId
      const entry = db.transcripts[sessionId]?.find(e => e.id === entryId)
      event = {
        ...event,
        offset: entry?.kind === 'assistant' || entry?.kind === 'thinking' ? entry.text.length : 0,
      }
    }
    const streaming = streamingBySession.get(sessionId) ?? new Set<string>()
    streamingBySession.set(sessionId, streaming)
    if (event.type === 'delta') streaming.add(event.entryId)
    else if (event.type === 'entry') streaming.delete(event.entry.id)
    else if (event.type === 'turn.end' || event.type === 'exit') streaming.clear()
    db.transcripts[sessionId] = applyHarnessEvent(db.transcripts[sessionId] ?? [], event)
    const pending = (db.pending[sessionId] ??= [])
    emit({ type: 'session.event', sessionId, event })
    switch (event.type) {
      case 'state':
        touch(s, {
          state: event.state,
          waitingFor:
            event.state === 'waiting'
              ? pending[0]?.kind === 'question'
                ? 'question'
                : 'permission'
              : null,
        })
        if (event.state === 'idle') pumpQueue(sessionId)
        break
      case 'permission.request':
        pending.push(event.request)
        break
      case 'permission.resolved':
        db.pending[sessionId] = pending.filter(p => p.id !== event.requestId)
        break
      case 'todos':
        db.todos[sessionId] = event.todos
        break
      case 'goal':
        db.goals[sessionId] = event.goal
        break
      case 'usage': {
        const m = s.metrics
        const prev = m.tokensByModel[event.model] ?? {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        }
        const next = event.cumulative
          ? event.usage
          : {
              input: prev.input + event.usage.input,
              output: prev.output + event.usage.output,
              cacheRead: prev.cacheRead + event.usage.cacheRead,
              cacheWrite: prev.cacheWrite + event.usage.cacheWrite,
            }
        m.tokensByModel = { ...m.tokensByModel, [event.model]: next }
        m.tokens = Object.values(m.tokensByModel).reduce(
          (a, t) => ({
            input: a.input + t.input,
            output: a.output + t.output,
            cacheRead: a.cacheRead + t.cacheRead,
            cacheWrite: a.cacheWrite + t.cacheWrite,
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        )
        if (event.costUsd !== null) m.costUsd = (m.costUsd ?? 0) + event.costUsd
        if (event.contextTokens !== null) m.contextTokens = event.contextTokens
        touch(s)
        break
      }
      case 'turn.end':
        {
          const queue = queueOf(sessionId)
          const release = releasing.delete(sessionId)
          if (event.ok || release)
            queue.messages = queue.messages.filter(m => m.state !== 'sending')
          else
            for (const message of queue.messages)
              if (message.state === 'sending') message.state = 'uncertain'
          if (!event.ok && !release) queue.paused = true
          queueChanged(sessionId)
        }
        s.metrics.turns++
        s.metrics.activeMs = (s.metrics.activeMs ?? 0) + event.durationMs
        touch(s)
        break
      case 'entry':
        if (event.entry.kind === 'tool') s.metrics.toolCalls++
        break
      case 'model':
        touch(s, { model: event.model })
        break
      case 'permission.mode':
        touch(s, { permissionMode: event.mode })
        break
      case 'exit':
        {
          const queue = queueOf(sessionId)
          queue.paused = true
          for (const message of queue.messages)
            if (message.state === 'sending') message.state = 'uncertain'
          queueChanged(sessionId)
        }
        touch(s, {
          state: event.outcome === 'failed' ? 'failed' : 'ended',
          endedAt: nowIso(),
          error: event.error,
        })
        break
    }
  }

  // ── the scripted assistant ──
  const answerWaiters = new Map<string, (a: PermissionAnswer) => void>()
  const later = (ms: number) => new Promise(r => setTimeout(r, ms))

  async function scriptedTurn(sessionId: string, message: UserMessage) {
    if (replyDelay === null) return
    const id = () => `mock-${++seq}`
    const ev = (e: HarnessEvent) => harnessEvent(sessionId, e)
    await later(replyDelay)
    const started = Date.now()
    if (/\b(run|delete)\b/i.test(message.text)) {
      const toolUseId = id()
      const command = /\bdelete\b/i.test(message.text) ? 'rm -rf build/' : 'npm test'
      ev({
        type: 'entry',
        entry: {
          kind: 'tool',
          id: toolUseId,
          name: 'Bash',
          input: { command },
          at: nowIso(),
          parentToolUseId: null,
        },
      })
      const request: PermissionRequest = {
        id: id(),
        sessionId,
        kind: 'tool',
        toolName: 'Bash',
        toolUseId,
        input: { command },
        title: `Claude wants to run: ${command}`,
        description: null,
        canAlwaysAllow: true,
        defaultToDeny: command.startsWith('rm'),
        createdAt: nowIso(),
      }
      ev({ type: 'permission.request', request })
      ev({ type: 'state', state: 'waiting' })
      const answer = await new Promise<PermissionAnswer>(r => answerWaiters.set(request.id, r))
      ev({ type: 'permission.resolved', requestId: request.id, behavior: answer.behavior })
      ev({ type: 'state', state: 'running' })
      ev({
        type: 'tool.result',
        toolUseId,
        result:
          answer.behavior === 'allow'
            ? toolResult(true, '✓ 212 tests passed')
            : toolResult(false, answer.message || 'The user denied this.'),
      })
    }
    const entryId = id()
    const reply = `Mock reply to: "${message.text.slice(0, 80)}". Nothing ran for real; this is fixture data.`
    for (const word of reply.match(/\S+\s*/g) ?? []) {
      ev({ type: 'delta', entryId, kind: 'assistant', text: word, parentToolUseId: null })
      await later(30)
    }
    ev({
      type: 'entry',
      entry: {
        kind: 'assistant',
        id: entryId,
        text: reply,
        model: sessionOf(sessionId).model,
        at: nowIso(),
        parentToolUseId: null,
      },
    })
    ev({
      type: 'usage',
      model: sessionOf(sessionId).model ?? 'claude-sonnet-5-5',
      usage: { input: 1200, output: 80, cacheRead: 30_000, cacheWrite: 400 },
      cumulative: false,
      costUsd: 0.01,
      contextTokens: 32_000,
    })
    ev({ type: 'turn.end', durationMs: Date.now() - started, ok: true, error: null })
    ev({ type: 'state', state: 'idle' })
  }

  function userTurn(sessionId: string, message: UserMessage) {
    harnessEvent(sessionId, { type: 'state', state: 'running' })
    harnessEvent(sessionId, {
      type: 'entry',
      entry: {
        kind: 'user',
        id: `mock-${++seq}`,
        text: message.text,
        at: nowIso(),
        parentToolUseId: null,
      },
    })
    void scriptedTurn(sessionId, message)
  }

  function newSession(project: ProjectDetail, o: Partial<Session> & { title: string }): Session {
    const id = fakeUuid(`mock-session-${Date.now()}-${++seq}`)
    const s: Session = {
      id,
      harness: 'claude',
      project: project.name,
      projects: [project.name],
      tags: [],
      pinned: false,
      archived: false,
      origin: 'odin',
      state: 'idle',
      waitingFor: null,
      cwd: project.path,
      workspace: { kind: 'checkout' },
      branch: project.git.branch,
      model: null,
      permissionMode: db.settings.settings.defaultPermissionMode,
      agent: null,
      agentVersion: null,
      templateId: null,
      parentId: null,
      aside: false,
      pull: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      endedAt: null,
      error: null,
      metrics: emptyMetrics(),
      ...o,
    }
    db.sessions.unshift(s)
    db.transcripts[id] ??= []
    return s
  }

  const firstPrompt = (id: string) => {
    const first = db.transcripts[id]?.find(e => e.kind === 'user')
    return first?.kind === 'user' ? first.text : ''
  }

  function installationState(i: Installation): Installation {
    const lib = db.library.find(a => a.kind === i.kind && a.id === i.id)
    const libraryVersion = lib?.version ?? null
    const p = i.projectVersion
    const state: Installation['state'] =
      p === null
        ? 'missing'
        : p === i.installedVersion
          ? libraryVersion === i.installedVersion
            ? 'current'
            : 'update-available'
          : libraryVersion === i.installedVersion
            ? 'modified'
            : 'conflict'
    return { ...i, libraryVersion, state }
  }

  const workspaceFiles: Record<string, string> = {
    'README.md':
      '# Project notes\n\nEdit **Markdown** with live preview.\n\n- Review the plan\n- Ship the changes\n',
    'data/results.csv':
      'id,name,status\n00123,First experiment,complete\n00456,"Second, larger experiment",pending\n',
    'src/example.ts': 'export const greeting = "Hello Odin"\n',
    // files the running session's transcript reads and edits, so its "This session" list opens them
    'packages/shared/src/transcript.ts':
      '// Folding live harness events into a transcript.\nexport function applyHarnessEvent() {}\n',
    'packages/web/src/screens/session/SessionScreen.vue':
      '<script setup lang="ts">\n// The session screen.\n</script>\n',
    'packages/web/src/screens/session/SessionSide.vue':
      '<script setup lang="ts">\n// The side column.\n</script>\n',
    'packages/web/src/app/router.ts': "export const routes = [{ path: '/s/:id' }]\n",
    'analysis.ipynb': JSON.stringify({
      cells: [
        {
          cell_type: 'markdown',
          id: 'intro',
          source: '# Analysis\n\nA first look at the results.',
        },
        {
          cell_type: 'code',
          id: 'load',
          execution_count: 1,
          source: 'import pandas as pd\ndata = pd.read_csv("data/results.csv")\ndata.head()',
          outputs: [
            {
              output_type: 'execute_result',
              execution_count: 1,
              metadata: {},
              data: {
                'text/plain':
                  '      id                      name    status\n0    123           First experiment  complete\n1    456  Second, larger experiment   pending',
              },
            },
          ],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  }
  const workspacePaths = (): FileMatch[] => {
    const dirs = new Set<string>()
    for (const key of Object.keys(workspaceFiles)) {
      const parts = key.split('/')
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
    return [
      ...[...dirs].map(path => ({ path, kind: 'directory' as const })),
      ...Object.keys(workspaceFiles).map(path => ({ path, kind: 'file' as const })),
    ]
  }
  const searchFiles = (query: string): FileSearchResult => ({
    query,
    matches: fuzzyMatchPaths(workspacePaths(), query),
    truncated: false,
  })

  const api: MockApi = {
    ...mockNotebooks({
      project: projectOf,
      session: sessionOf,
      emit,
      files: {
        read: path => workspaceFiles[path],
        write: (path, text) => {
          workspaceFiles[path] = text
        },
      },
    }),
    searchSessionFiles: (id, query) =>
      respond(() => {
        sessionOf(id)
        return searchFiles(query)
      }),
    searchProjectFiles: (name, query) =>
      respond(() => {
        projectOf(name)
        return searchFiles(query)
      }),
    readProjectFile: (name, path) =>
      respond(() => {
        projectOf(name)
        const known = MOCK_FILE_MAP.files.find(f => f.path === path)
        if (!known) throw new ApiRequestError(404, 'File not found')
        const content = mockFileText(path)
        return { path, content, version: fakeHash(content), size: known.size }
      }),
    getProjectFileMap: name =>
      respond(() => {
        projectOf(name)
        return MOCK_FILE_MAP
      }),
    listSessionFiles: (id, path = '') =>
      respond(() => {
        sessionOf(id)
        const prefix = path ? `${path}/` : ''
        const names = new Map<string, 'file' | 'directory'>()
        for (const key of Object.keys(workspaceFiles)) {
          if (!key.startsWith(prefix)) continue
          const rest = key.slice(prefix.length)
          const name = rest.split('/')[0]!
          names.set(name, rest.includes('/') ? 'directory' : 'file')
        }
        return {
          path,
          truncated: false,
          entries: [...names].map(([name, kind]) => ({
            name,
            kind,
            path: prefix + name,
            size: kind === 'file' ? workspaceFiles[prefix + name]!.length : null,
          })),
        }
      }),
    readSessionFile: (id, path) =>
      respond(() => {
        sessionOf(id)
        const content = workspaceFiles[path]
        if (content === undefined) throw new ApiRequestError(404, 'File not found')
        return {
          path,
          content,
          version: fakeHash(content),
          size: new TextEncoder().encode(content).length,
        }
      }),
    createSessionFile: (id, path, content = '') =>
      respond(() => {
        sessionOf(id)
        const slash = path.lastIndexOf('/')
        const folder = slash < 0 ? '' : path.slice(0, slash)
        const folderExists =
          !folder || Object.keys(workspaceFiles).some(key => key.startsWith(`${folder}/`))
        if (!folderExists) throw new ApiRequestError(404, 'The folder for this file does not exist')
        if (
          workspaceFiles[path] !== undefined ||
          Object.keys(workspaceFiles).some(key => key.startsWith(`${path}/`))
        )
          throw new ApiRequestError(409, 'A file or folder already exists at this path')
        workspaceFiles[path] = content
        return {
          path,
          content,
          version: fakeHash(content),
          size: new TextEncoder().encode(content).length,
        }
      }),
    saveSessionFile: (id, path, content, version) =>
      respond(() => {
        sessionOf(id)
        if (workspaceFiles[path] === undefined) throw new ApiRequestError(404, 'File not found')
        if (fakeHash(workspaceFiles[path]!) !== version)
          throw new ApiRequestError(
            409,
            'This file changed on disk. Your draft has not been saved.',
          )
        workspaceFiles[path] = content
        return {
          path,
          content,
          version: fakeHash(content),
          size: new TextEncoder().encode(content).length,
        }
      }),
    db,
    emit,
    harnessEvent,

    // ── projects ──
    listProjects: () => respond(() => db.projects.map(summary)),
    browseProjectFolders: (path = '/work') =>
      respond(() => ({
        path,
        parent: path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/',
        folders:
          path === '/work'
            ? ['atlas', 'odin', 'rick'].map(name => ({ name, path: `/work/${name}` }))
            : path === '/'
              ? [{ name: 'work', path: '/work' }]
              : [],
      })),
    getProject: name => respond(() => detail(projectOf(name))),
    createProject: req =>
      respond(() => {
        if (!req.path.startsWith('/')) throw new ApiRequestError(400, 'path must be absolute')
        const name = req.name ?? slugify(req.path.split('/').filter(Boolean).pop() ?? '')
        if (!PROJECT_NAME_PATTERN.test(name))
          throw new ApiRequestError(400, `invalid project name "${name}"`)
        if (db.projects.some(p => p.name === name))
          throw new ApiRequestError(409, `Project "${name}" already exists`)
        if (db.projects.some(p => p.path === req.path))
          throw new ApiRequestError(409, 'That folder is already registered')
        const p: ProjectDetail = {
          name,
          title: name,
          description: '',
          path: req.path,
          repo: null,
          missing: false,
          sessions: { running: 0, waiting: 0, total: 0 },
          sync: { state: 'off', lastSyncAt: null, error: null },
          activity: Array.from({ length: 14 }, () => 0),
          updatedAt: nowIso(),
          settings: {
            title: name,
            description: '',
            repo: null,
            defaultBranch: 'main',
            commands: {},
          },
          manifestError: null,
          git: { branch: 'main', headSha: null, dirty: false, ahead: 0, behind: 0 },
          status: null,
          agents: [],
          dirtyFiles: [],
          context: emptyProjectContext(),
          firstSessionAt: null,
          lastSessionAt: null,
        }
        db.projects.push(p)
        emit({ type: 'project.updated', project: name })
        return detail(p)
      }),
    updateProjectSettings: (name, req) =>
      respond(() => {
        const p = projectOf(name)
        const st = p.settings
        if (req.title !== undefined) st.title = req.title ?? name
        if (req.description !== undefined) st.description = req.description ?? ''
        if (req.repo !== undefined) st.repo = req.repo
        if (req.defaultBranch !== undefined) st.defaultBranch = req.defaultBranch ?? 'main'
        if (req.commands !== undefined) st.commands = req.commands ?? {}
        if (req.githubEnabled !== undefined) st.githubEnabled = req.githubEnabled ?? false
        Object.assign(p, {
          title: st.title,
          description: st.description,
          repo: st.repo,
          updatedAt: nowIso(),
        })
        if (!st.repo || !st.githubEnabled) p.sync = { state: 'off', lastSyncAt: null, error: null }
        else if (p.sync.state === 'off') p.sync = { state: 'idle', lastSyncAt: null, error: null }
        emit({ type: 'project.updated', project: name })
        return detail(p)
      }),
    updateProjectSources: (name, req) =>
      respond(() => {
        const p = projectOf(name)
        if (req === null) {
          p.context = {
            ...p.context,
            customized: false,
            sources: {
              ...p.context.discovered,
              status: [...p.context.discovered.status],
              planning: [...p.context.discovered.planning],
            },
            missing: [],
          }
        } else {
          const parsed = parseProjectSources(req)
          if (!parsed.ok) throw new ApiRequestError(400, parsed.error)
          p.context = { ...p.context, customized: true, sources: parsed.selection, missing: [] }
        }
        p.updatedAt = nowIso()
        emit({ type: 'project.updated', project: name })
        return detail(p)
      }),
    refreshProject: name =>
      respond(() => {
        projectOf(name)
        emit({ type: 'project.updated', project: name })
      }),
    removeProject: name =>
      respond(() => {
        projectOf(name)
        if (db.sessions.some(s => (s.projects ?? [s.project]).includes(name)))
          throw new ApiRequestError(
            409,
            'This project is configured in sessions. Remove those sessions before removing the project.',
          )
        db.projects = db.projects.filter(p => p.name !== name)
        emit({ type: 'project.removed', project: name })
      }),
    discoverSessions: name => respond(() => (projectOf(name), { added: 0 })),
    getClaudeCodeTracking: name =>
      respond(
        () => (
          projectOf(name),
          { enabled: !!db.tracking[name], settingsPath: '.claude/settings.local.json' }
        ),
      ),
    setClaudeCodeTracking: (name, enabled) =>
      respond(() => {
        projectOf(name)
        db.tracking[name] = enabled
        return { enabled, settingsPath: '.claude/settings.local.json' }
      }),

    // ── sessions ──
    listSessions: (filter = {}) =>
      respond(() => {
        const f = { archived: false, ...filter }
        if (filter.archived === undefined && filter.q) delete (f as SessionFilter).archived
        const list = db.sessions
          .filter(s => matches(s, f, firstPrompt(s.id)))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        return f.limit ? list.slice(0, f.limit) : list
      }),
    getSession: id =>
      respond((): SessionDetail => {
        const s = sessionOf(id)
        return {
          ...s,
          transcript: db.transcripts[id] ?? [],
          streaming: [...(streamingBySession.get(id) ?? [])],
          pending: db.pending[id] ?? [],
          todos: db.todos[id] ?? [],
          goal: db.goals[id] ?? null,
          artifacts: db.artifacts.filter(a => a.sessionId === id),
          live: s.state === 'running' || s.state === 'waiting',
          slashCommands: MOCK_SLASH_COMMANDS,
          messageQueue: queueOf(id),
        }
      }),
    getSessionTask: (id, key) =>
      respond(() => {
        sessionOf(id)
        const entry = db.transcripts[id]?.find(e => e.kind === 'task' && e.id === key)
        if (!entry || entry.kind !== 'task') throw new ApiRequestError(404, 'unknown session task')
        const child = entry.task.childSessionId
        if (child && db.transcripts[child])
          return { status: 'available' as const, transcript: db.transcripts[child] }
        return {
          status: 'unavailable' as const,
          reason: 'Child history is unavailable for this task.',
        }
      }),
    startSession: req =>
      respond(() => {
        const project = projectOf(req.project)
        const configured = [...new Set([req.project, ...(req.projects ?? [])])]
        if (req.projects && !req.projects.includes(req.project))
          throw new ApiRequestError(400, 'projects must include the working project')
        for (const name of configured) {
          if (projectOf(name).missing)
            throw new ApiRequestError(409, `project ${name} is missing on disk`)
        }
        if (req.templateId !== undefined || req.agent !== undefined)
          throw new ApiRequestError(
            400,
            'Sessions use the default agent; install skills and subagents from the library.',
          )
        let text = req.prompt?.text ?? ''
        if (!text.trim()) throw new ApiRequestError(400, 'a session needs a prompt')
        const title = req.title ?? text.split('\n')[0]!.slice(0, 60)
        const id = fakeUuid(`mock-new-${Date.now()}-${seq}`)
        const worktree = req.worktree ?? db.settings.settings.defaultWorktree
        const branch = worktree ? (req.branch ?? sessionBranch(title, id)) : project.git.branch
        text = fillPrompt(text, {
          project: project.name,
          branch: branch ?? '',
          ...req.variables,
        })
        const agent = null
        const harness = req.harness ?? db.settings.settings.defaultHarness ?? 'claude'
        const family = harness === 'codex-wsl' ? 'codex' : harness
        const defaults = db.settings.settings.harnessDefaults?.[harness]
        const s = newSession(project, {
          harness,
          ...(req.runtimeOptions ? { runtimeOptions: clone(req.runtimeOptions) } : {}),
          effort: req.effort ?? null,
          projects: configured,
          title,
          model:
            req.model ??
            defaults?.model ??
            (family === 'claude'
              ? (db.settings.settings.defaultModel ?? 'claude-sonnet-5-5')
              : 'codex-test'),
          permissionMode:
            req.permissionMode ??
            defaults?.permissionMode ??
            (family === 'claude' ? db.settings.settings.defaultPermissionMode : 'default'),
          agent,
          agentVersion: libraryAgentId(agent)
            ? (db.library.find(a => a.kind === 'agent' && a.id === libraryAgentId(agent))
                ?.version ?? null)
            : null,
          workspace:
            worktree && branch
              ? {
                  kind: 'worktree',
                  path: `/home/me/.odin/worktrees/${project.name}/${slugify(branch)}`,
                  branch,
                }
              : { kind: 'checkout' },
          cwd:
            worktree && branch
              ? `/home/me/.odin/worktrees/${project.name}/${slugify(branch)}`
              : project.path,
          branch,
          templateId: null,
          tags: req.tags ?? [],
        })
        emit({ type: 'session.updated', session: s })
        userTurn(s.id, { ...req.prompt, text })
        return s
      }),
    updateSession: (id, req) =>
      respond(() => {
        const s = sessionOf(id)
        const { model, permissionMode, aside, addProjects, ...rest } = req
        if (addProjects?.length) {
          if (s.state === 'running' || s.state === 'waiting')
            throw new ApiRequestError(
              409,
              'wait for the current turn to finish before adding a project',
            )
          s.projects = [...new Set([...s.projects, ...addProjects])]
        }
        if (aside === true) throw new ApiRequestError(400, "a session can't become a side thread")
        // Promote: an ordinary session from here on (lists, counts, the sidebar).
        if (aside === false) s.aside = false
        // Not live: stored on the record for the resume, like core.
        const live = s.state === 'running' || s.state === 'waiting' || s.state === 'idle'
        touch(
          s,
          live
            ? rest
            : {
                ...rest,
                ...(model !== undefined && { model }),
                ...(permissionMode !== undefined && { permissionMode }),
              },
        )
        if (!live) return s
        if (model !== undefined) harnessEvent(id, { type: 'model', model })
        if (permissionMode !== undefined)
          harnessEvent(id, { type: 'permission.mode', mode: permissionMode })
        return s
      }),
    deleteSession: id =>
      respond(() => {
        sessionOf(id)
        db.sessions = db.sessions.filter(s => s.id !== id)
        delete db.transcripts[id]
        emit({ type: 'session.removed', sessionId: id })
      }),
    runShell: (id, command) =>
      respond((): ShellRunResult => {
        const s = sessionOf(id)
        if (!command.trim()) throw new ApiRequestError(400, 'command must be a non-empty string')
        const failed = /^\s*(false|exit\s+[1-9])/.test(command)
        return {
          command,
          cwd: s.cwd,
          output: failed ? '' : `On branch main\nnothing to commit, working tree clean\n`,
          exitCode: failed ? 1 : 0,
          timedOut: false,
          truncated: false,
          durationMs: 42,
        }
      }),
    sendMessage: (id, message) =>
      respond(() => {
        const s = sessionOf(id)
        if (!message.text.trim()) throw new ApiRequestError(400, 'empty message')
        const keys = messageKeys.get(id) ?? new Map<string, string>()
        if (message.clientId && keys.has(message.clientId)) {
          if (keys.get(message.clientId) !== JSON.stringify(message))
            throw new ApiRequestError(409, 'message id already used for different content')
          return s
        }
        if (s.state === 'waiting') throw new ApiRequestError(409, 'answer the open prompt first')
        if (message.clientId) keys.set(message.clientId, JSON.stringify(message))
        messageKeys.set(id, keys)
        const queue = queueOf(id)
        if (!queue.messages.length) queue.paused = false
        queue.messages.push({
          id: message.clientId ?? `queue-${++seq}`,
          message: clone(message),
          state: 'queued',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        queueChanged(id)
        pumpQueue(id)
        return s
      }),
    queue: id => respond(() => queueOf(id)),
    editQueuedMessage: (id, messageId, message) =>
      respond(() => {
        if (!message.text.trim()) bad('empty message')
        Object.assign(editableMessage(id, messageId), {
          message: clone(message),
          updatedAt: nowIso(),
        })
        return queueChanged(id)
      }),
    cancelQueuedMessage: (id, messageId) =>
      respond(() => {
        const queue = queueOf(id)
        const message = queue.messages.find(m => m.id === messageId) ?? notFound('queued message')
        if (message.state === 'sending')
          throw new ApiRequestError(409, 'message has already been dispatched')
        queue.messages = queue.messages.filter(m => m.id !== messageId)
        return queueChanged(id)
      }),
    resumeQueue: id =>
      respond(() => {
        const queue = queueOf(id)
        if (queue.messages.some(m => m.state === 'uncertain'))
          throw new ApiRequestError(409, 'resolve uncertain messages first')
        queue.paused = false
        queueChanged(id)
        pumpQueue(id)
        return queueOf(id)
      }),
    sendNow: (id, message) =>
      respond(() => {
        const s = sessionOf(id)
        if (queueOf(id).messages.some(m => m.state === 'uncertain'))
          throw new ApiRequestError(409, 'resolve uncertain messages first')
        if (message && !placeNext(id, message)) return queueOf(id)
        if (!queueOf(id).messages.some(m => m.state === 'queued'))
          throw new ApiRequestError(409, 'nothing queued to send')
        const wasPaused = queueOf(id).paused
        queueOf(id).paused = false
        if (wasPaused) pauseAfter.add(id)
        if (s.state === 'running' || s.state === 'waiting') {
          releasing.add(id)
          for (const p of db.pending[id] ?? [])
            harnessEvent(id, {
              type: 'permission.resolved',
              requestId: p.id,
              behavior: 'cancelled',
            })
          harnessEvent(id, { type: 'turn.end', durationMs: 0, ok: false, error: 'interrupted' })
          harnessEvent(id, { type: 'state', state: 'idle' })
        } else pumpQueue(id)
        return queueOf(id)
      }),
    retryQueuedMessage: (id, messageId) =>
      respond(() => {
        const queue = queueOf(id)
        const message = queue.messages.find(m => m.id === messageId) ?? notFound('queued message')
        if (message.state !== 'uncertain')
          throw new ApiRequestError(409, 'only uncertain messages can be retried')
        message.state = 'queued'
        message.updatedAt = nowIso()
        queue.paused = true
        return queueChanged(id)
      }),
    answerPermission: (id, requestId, answer) =>
      respond(() => {
        sessionOf(id)
        const open = (db.pending[id] ?? []).find(p => p.id === requestId)
        if (!open) throw new ApiRequestError(409, 'that prompt is no longer open')
        const waiter = answerWaiters.get(requestId)
        if (waiter) {
          answerWaiters.delete(requestId)
          waiter(answer)
          return
        }
        // A fixture prompt with no script behind it: resolve it here.
        harnessEvent(id, { type: 'permission.resolved', requestId, behavior: answer.behavior })
        if (open.toolUseId) {
          harnessEvent(id, {
            type: 'tool.result',
            toolUseId: open.toolUseId,
            result:
              answer.behavior === 'allow'
                ? toolResult(true, 'done')
                : toolResult(false, answer.message || 'The user denied this.'),
          })
        }
        // still waiting while another prompt is open
        if (!(db.pending[id] ?? []).length) harnessEvent(id, { type: 'state', state: 'idle' })
      }),
    interruptSession: id =>
      respond(() => {
        const s = sessionOf(id)
        queueOf(id).paused = true
        queueChanged(id)
        if (s.state === 'running' || s.state === 'waiting') {
          for (const p of db.pending[id] ?? [])
            harnessEvent(id, {
              type: 'permission.resolved',
              requestId: p.id,
              behavior: 'cancelled',
            })
          harnessEvent(id, { type: 'turn.end', durationMs: 0, ok: false, error: 'interrupted' })
          harnessEvent(id, { type: 'state', state: 'idle' })
        }
      }),
    endSession: id =>
      respond(() => {
        sessionOf(id)
        harnessEvent(id, { type: 'exit', outcome: 'closed', error: null })
        return sessionOf(id)
      }),
    forkSession: (id, req) =>
      respond(() => {
        const parent = sessionOf(id)
        const project = projectOf(parent.project)
        const aside = req.aside === true
        if (aside && !req.prompt?.text.trim())
          throw new ApiRequestError(400, 'a side thread needs a prompt')
        if (aside && req.worktree)
          throw new ApiRequestError(400, 'a side thread never gets a worktree')
        // Any parent state is fine for a side thread: it forks the conversation as stored so far.
        const title =
          req.title ??
          (aside
            ? `Side: ${req.prompt!.text.trim().split('\n')[0]!.slice(0, 60)}`
            : `${parent.title} (fork)`)
        const s = newSession(project, {
          title,
          harness: parent.harness,
          projects: [...parent.projects],
          parentId: parent.id,
          aside,
          model: req.model ?? parent.model,
          effort: parent.effort ?? null,
          permissionMode: req.permissionMode ?? (aside ? 'plan' : parent.permissionMode),
          agent: parent.agent,
          agentVersion: parent.agentVersion,
          templateId: parent.templateId,
          tags: [...parent.tags],
          workspace: parent.workspace,
          cwd: parent.cwd,
          branch: parent.branch,
        })
        db.transcripts[s.id] = clone(db.transcripts[parent.id] ?? [])
        emit({ type: 'session.updated', session: s })
        if (req.prompt) userTurn(s.id, req.prompt)
        return s
      }),
    getNativeCatalog: () =>
      respond(() => ({
        agents: [
          { name: 'build', description: 'Build and edit', mode: 'primary' as const },
          { name: 'plan', description: 'Explore and plan', mode: 'primary' as const },
          { name: 'explore', description: 'Search the project', mode: 'subagent' as const },
        ],
        commands: [{ name: 'review', description: 'Review the current changes' }],
        skills: [{ name: 'project-guide', description: 'Project conventions' }],
        providers: [{ id: 'opencode', name: 'OpenCode', enabled: true }],
        mcp: [{ name: 'odin', status: 'connected' }],
        plugins: ['odin'],
      })),
    getSessionNativeState: () => respond(() => ({ revert: null })),
    sessionNativeAction: (_id, action) =>
      respond(() => ({
        revert: action.type === 'revert' ? { messageId: action.messageId } : null,
      })),
    listModels: harness =>
      respond(() => {
        if (harness === 'opencode')
          return [
            {
              value: 'opencode/test',
              displayName: 'OpenCode test model',
              description: 'Mock model',
              resolved: 'opencode/test',
              variants: ['low', 'high'],
            },
          ]
        if (harness?.startsWith('codex'))
          return [
            {
              value: 'codex-test',
              displayName: 'Codex test model',
              description: 'Mock model',
              resolved: 'codex-test',
            },
          ]
        if (harness === 'grok')
          return [
            {
              value: 'grok-4.7',
              displayName: 'Grok 4.7',
              description: 'Mock model',
              resolved: 'grok-4.7',
            },
            {
              value: 'grok-4.7-build-fast',
              displayName: 'Grok 4.7 Fast',
              description: 'Mock model',
              resolved: 'grok-4.7-build-fast',
            },
          ]
        if (harness === 'antigravity')
          return [
            {
              value: 'gemini-3.8-flash',
              displayName: 'Gemini 3.8 Flash',
              description: 'Mock model',
              resolved: 'gemini-3.8-flash',
              effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
            {
              value: 'gemini-3.8-pro',
              displayName: 'Gemini 3.8 Pro',
              description: 'Mock model',
              resolved: 'gemini-3.8-pro',
              effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
            },
          ]
        return db.models
      }),

    // ── artifacts ──
    getArtifact: id =>
      respond(() => {
        const artifact = db.artifacts.find(a => a.id === id) ?? notFound(`artifact ${id}`)
        return { artifact, versions: db.artifactVersions.filter(v => v.artifactId === id) }
      }),
    submitArtifact: (id, version, data) =>
      respond(() => {
        const artifact = db.artifacts.find(a => a.id === id) ?? notFound(`artifact ${id}`)
        if (!db.artifactVersions.some(v => v.artifactId === id && v.version === version))
          throw new ApiRequestError(400, `no version ${version}`)
        if (JSON.stringify(data).length > 64 * 1024)
          throw new ApiRequestError(413, 'answer too large')
        const s = sessionOf(artifact.sessionId)
        userTurn(s.id, {
          text: `Answer from "${artifact.title}" (v${version}):\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``,
        })
        return s
      }),
    artifactUrl(id, version) {
      const html = db.artifactHtml[`${id}/${version}`] ?? '<!doctype html><p>Missing artifact</p>'
      const bridge = `<script>window.odin={theme:{},submit:function(data){parent.postMessage({type:"odin.submit",artifactId:${id},version:${version},data:data},"*")}};</script>`
      const page = html.includes('</head>')
        ? html.replace('</head>', `${bridge}</head>`)
        : bridge + html
      return `data:text/html;base64,${btoa(unescape(encodeURIComponent(page)))}`
    },

    // ── library ──
    listLibrary: kind =>
      respond(() =>
        db.library.filter(a => LIBRARY_KINDS.includes(a.kind) && (!kind || a.kind === kind)),
      ),
    getAsset: (kind, id) =>
      respond(() => {
        const asset = assetOf(kind, id)
        return {
          asset,
          files: db.libraryFiles[`${kind}/${id}`] ?? {},
          versions: db.libraryVersions[`${kind}/${id}`] ?? [],
          installs: db.installations
            .filter(i => i.kind === kind && i.id === id)
            .map(installationState),
        }
      }),
    previewPluginImport: req =>
      respond(() => {
        const src = req.source
        if (src.type === 'git' && !/^(https:\/\/|ssh:\/\/|git@)/.test(src.url))
          throw new ApiRequestError(400, 'git url must be an https, ssh or git@ address')
        if (src.type === 'local' && !src.path.startsWith('/'))
          throw new ApiRequestError(400, 'a local source needs an absolute path')
        const from = src.type === 'git' ? src.url : src.path
        const name =
          from
            .replace(/\/+$/, '')
            .replace(/\.git$/, '')
            .split(/[/:]/)
            .pop() ?? 'plugin'
        const id = req.id ?? slugify(name)
        if (db.library.some(a => a.kind === 'plugin' && a.id === id))
          throw new ApiRequestError(
            409,
            `the library already has a plugin "${id}": pass another id`,
          )
        const previewId = fakeHash(`import/${from}/${pendingImports.size}/${Date.now()}`).slice(
          0,
          16,
        )
        const preview: ImportPreview = {
          previewId,
          id,
          name,
          description: `Imported from ${name}`,
          version: '0.3.0',
          members: [
            { kind: 'skill', id: 'changelog' },
            { kind: 'agent', id: 'release-reviewer' },
            { kind: 'mcp', id: 'github' },
            { kind: 'settings', id: 'hooks' },
          ],
          runs: [
            {
              kind: 'command',
              member: 'mcp/github',
              text: 'npx @modelcontextprotocol/server-github',
            },
            {
              kind: 'hook',
              member: 'settings/hooks',
              text: 'PostToolUse: [{"matcher":"Edit","hooks":[{"type":"command","command":"prettier --write"}]}]',
            },
          ],
          warnings: [
            'command "ship" became skill "ship" (Odin has no separate slash commands)',
            'not imported (Odin has no place for them): scripts/guard.sh',
          ],
          secrets: ['GITHUB_TOKEN'],
        }
        pendingImports.set(previewId, preview)
        return preview
      }),
    confirmPluginImport: previewId =>
      respond(() => {
        const preview = pendingImports.get(previewId) ?? notFound('that import preview')
        pendingImports.delete(previewId)
        const files: AssetFiles = {
          'plugin.json': JSON.stringify({
            name: preview.name,
            description: preview.description,
            version: preview.version,
          }),
        }
        const asset: LibraryAsset = {
          kind: 'plugin',
          id: preview.id,
          name: preview.name,
          description: preview.description,
          version: fakeHash(`plugin/${preview.id}/${JSON.stringify(files)}`),
          updatedAt: nowIso(),
          files: Object.keys(files),
          meta: {
            version: preview.version,
            includes: [],
            own: preview.members.map(m => ({ ...m, name: m.id, description: '', error: null })),
          },
          error: null,
          enabled: true,
        }
        db.library.push(asset)
        db.libraryFiles[`plugin/${preview.id}`] = files
        db.libraryVersions[`plugin/${preview.id}`] = [
          { version: asset.version, firstSeenAt: nowIso(), sessionCount: 0 },
        ]
        emit({ type: 'library.updated', kind: 'plugin', id: preview.id })
        return asset
      }),
    exportPlugin: (id, path) =>
      respond(() => {
        assetOf('plugin', id)
        if (!path.startsWith('/'))
          throw new ApiRequestError(400, 'path must be an absolute folder path')
        return {
          path,
          files: [
            '.claude-plugin/plugin.json',
            '.mcp.json',
            'hooks/hooks.json',
            'skills/release-notes/SKILL.md',
            'skills/triage/SKILL.md',
          ],
          skipped: [],
          notes: [
            'MCP server "publish": OAuth settings were dropped (Claude Code signs in on its own)',
          ],
        }
      }),
    getAssetVersion: (kind, id, version) =>
      respond(() => db.versionFiles[`${kind}/${id}@${version}`] ?? notFound(`version ${version}`)),
    saveAsset: (kind, id, files) =>
      respond(() => {
        if (!LIBRARY_KINDS.includes(kind)) throw new ApiRequestError(400, `unknown kind ${kind}`)
        if (!ASSET_ID_PATTERN.test(id)) throw new ApiRequestError(400, `invalid id "${id}"`)
        if (!Object.keys(files).length)
          throw new ApiRequestError(400, 'an asset needs at least one file')
        const version = fakeHash(`${kind}/${id}/${JSON.stringify(files)}`)
        const key = `${kind}/${id}`
        const existing = db.library.find(a => a.kind === kind && a.id === id)
        const text = Object.values(files).join('\n')
        const meta: Record<string, unknown> =
          kind === 'prompt' ? { variables: promptVariables(text) } : {}
        if (kind === 'template' || kind === 'mcp' || kind === 'settings') {
          try {
            Object.assign(meta, JSON.parse(text))
          } catch {
            throw new ApiRequestError(400, `${kind} files are JSON`)
          }
        }
        const asset: LibraryAsset = {
          kind,
          id,
          name: (meta.name as string) ?? existing?.name ?? id,
          description: (meta.description as string) ?? existing?.description ?? '',
          version,
          updatedAt: nowIso(),
          files: Object.keys(files),
          meta,
          error: null,
          enabled: existing?.enabled ?? true,
        }
        if (existing) Object.assign(existing, asset)
        else db.library.push(asset)
        db.libraryFiles[key] = files
        const versions = (db.libraryVersions[key] ??= [])
        if (!versions.some(v => v.version === version))
          versions.unshift({ version, firstSeenAt: nowIso(), sessionCount: 0 })
        db.versionFiles[`${key}@${version}`] = files
        emit({ type: 'library.updated', kind, id })
        return existing ?? asset
      }),
    setAssetEnabled: (kind, id, enabled) =>
      respond(() => {
        const a = assetOf(kind, id)
        a.enabled = enabled
        emit({ type: 'library.updated', kind, id })
        return clone(a)
      }),
    deleteAsset: (kind, id) =>
      respond(() => {
        assetOf(kind, id)
        db.library = db.library.filter(a => !(a.kind === kind && a.id === id))
        emit({ type: 'library.updated', kind, id })
      }),
    rescanLibrary: () => respond(() => undefined),
    listSecrets: () =>
      respond(() => {
        const users = secretUsers()
        return {
          secrets: [...secrets]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([name, t]) => ({ name, ...t, usedBy: users.get(name) ?? [] })),
          missing: [...users]
            .filter(([name]) => !secrets.has(name))
            .map(([name, usedBy]) => ({ name, usedBy })),
        }
      }),
    putSecret: (name, value) =>
      respond(() => {
        if (!SECRET_NAME_PATTERN.test(name)) throw new ApiRequestError(400, 'bad secret name')
        if (!value) throw new ApiRequestError(400, 'value must be a non-empty string')
        const now = new Date().toISOString()
        secrets.set(name, { createdAt: secrets.get(name)?.createdAt ?? now, updatedAt: now })
        return { name, ...secrets.get(name)!, usedBy: secretUsers().get(name) ?? [] }
      }),
    deleteSecret: name =>
      respond(() => {
        if (!secrets.delete(name)) notFound(`secret ${name}`)
      }),
    getMcpOAuth: id =>
      respond(() => {
        oauthServer(id)
        const on = signedIn.has(id)
        return {
          id,
          state: on ? 'connected' : 'needs-sign-in',
          issuer: on ? 'https://auth.example.com' : null,
          scope: on ? 'read' : null,
          expiresAt: on ? fromNow(HOUR_MS) : null,
        }
      }),
    startMcpOAuth: (id, origin) =>
      respond(() => {
        oauthServer(id)
        setTimeout(() => signedIn.add(id), 1500) // the "browser" finishes a moment later
        return { authorizationUrl: `${origin}/mock-sign-in?server=${encodeURIComponent(id)}` }
      }),
    disconnectMcpOAuth: id =>
      respond(() => {
        oauthServer(id)
        signedIn.delete(id)
      }),
    listInstallations: project =>
      respond(
        () => (
          projectOf(project),
          db.installations.filter(i => i.project === project).map(installationState)
        ),
      ),
    install: (project, req) =>
      respond(() => {
        projectOf(project)
        const asset = assetOf(req.kind, req.id)
        if (!isInstallable(req.kind))
          throw new ApiRequestError(400, `${req.kind} assets aren't installed into projects`)
        if (req.kind === 'plugin' && req.action === 'preview')
          return { installation: null, changed: [], preview: pluginPreview(project, asset) }
        if (req.kind === 'plugin' && req.action === 'install') {
          const pv = pluginPreview(project, asset)
          if (pv.confirm !== null && req.confirm !== pv.confirm)
            throw new ApiRequestError(
              409,
              `plugin "${req.id}" adds hooks or local commands: send action "preview", read it, and pass its confirm`,
            )
        }
        const key = `${project}/${req.kind}/${req.id}`
        let inst = db.installations.find(
          i => i.project === project && i.kind === req.kind && i.id === req.id,
        )
        const paths =
          req.kind === 'mcp'
            ? ['.mcp.json']
            : req.kind === 'settings'
              ? ['.claude/settings.json']
              : asset.files.map(
                  f => `.claude/${req.kind}s/${req.kind === 'skill' ? `${req.id}/` : ''}${f}`,
                )
        if (req.action === 'forget') {
          db.installations = db.installations.filter(i => i !== inst)
          return { installation: null, changed: [] }
        }
        if (req.action === 'push') {
          if (!inst) throw new ApiRequestError(404, 'not installed')
          const files: AssetFiles = db.projectFiles[key] ?? {}
          const version = fakeHash(`${req.kind}/${req.id}/${JSON.stringify(files)}`)
          Object.assign(asset, { version, updatedAt: nowIso() })
          db.libraryFiles[`${req.kind}/${req.id}`] = files
          inst.installedVersion = version
          inst.projectVersion = version
          emit({ type: 'library.updated', kind: req.kind, id: req.id })
        } else {
          if (inst && installationState(inst).state === 'modified' && !req.force) {
            throw new ApiRequestError(
              409,
              'the project copy was changed; update with force to overwrite it, or push it to the library',
            )
          }
          db.projectFiles[key] = clone(db.libraryFiles[`${req.kind}/${req.id}`] ?? {})
          if (!inst) {
            inst = {
              project,
              kind: req.kind,
              id: req.id,
              installedVersion: asset.version,
              libraryVersion: asset.version,
              projectVersion: asset.version,
              state: 'current',
              paths,
              installedAt: nowIso(),
            }
            db.installations.push(inst)
          }
          Object.assign(inst, {
            installedVersion: asset.version,
            projectVersion: asset.version,
            installedAt: nowIso(),
          })
        }
        const installation = installationState(inst)
        emit({ type: 'install.updated', installation })
        return { installation, changed: req.action === 'push' ? [] : paths }
      }),
    getProjectAssetFiles: (project, kind, id) =>
      respond(
        () =>
          db.projectFiles[`${project}/${kind}/${id}`] ?? notFound(`${kind} ${id} in ${project}`),
      ),

    // ── sync ──
    syncProject: name =>
      respond(() => {
        const p = projectOf(name)
        if (!p.repo || !p.settings.githubEnabled)
          throw new ApiRequestError(409, `GitHub sync is off for ${name} (no repo or no token)`)
        p.sync = { state: 'idle', lastSyncAt: nowIso(), error: null }
        emit({ type: 'sync.status', project: name, sync: p.sync })
      }),

    getProjectActivity: (project, days = 84) =>
      respond(() => {
        projectOf(project)
        if (!Number.isInteger(days) || days < 1 || days > 168) bad('days must be an integer 1–168')
        const known = new Map((db.activity[project] ?? []).map(d => [d.date, d]))
        const out = []
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date()
          d.setHours(12, 0, 0, 0)
          d.setDate(d.getDate() - i)
          const date = localDay(d)
          out.push(
            known.get(date) ?? {
              date,
              sessions: 0,
              activeMs: 0,
              costUsd: null,
              commits: null,
              added: 0,
              removed: 0,
            },
          )
        }
        return { days: out }
      }),
    listProjectBranches: project => respond(() => (projectOf(project), db.branches[project] ?? [])),
    removeWorktree: (project, path) =>
      respond(() => {
        const p = projectOf(project)
        const prefix = `/home/me/.odin/worktrees/${project}/`
        if (!path.startsWith('/') || path === p.path || !path.startsWith(prefix))
          bad(`${path} is not a Odin worktree of ${project}`)
        const live = db.sessions.find(
          x =>
            (x.state === 'running' || x.state === 'waiting' || x.state === 'idle') &&
            (x.cwd === path || x.cwd.startsWith(`${path}/`)),
        )
        if (live) throw new ApiRequestError(409, `session "${live.title}" is using this worktree`)
        for (const b of db.branches[project] ?? [])
          if (b.worktreePath === path) b.worktreePath = null
        emit({ type: 'project.updated', project })
      }),
    listProjectArtifacts: (project, limit) =>
      respond(() => {
        projectOf(project)
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
          bad('limit must be a positive integer')
        const all = db.artifacts
          .filter(a => a.project === project)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        return limit === undefined ? all : all.slice(0, limit)
      }),

    // ── metrics and settings ──
    getMetrics: q => respond(() => computeMetrics(db.sessions, q)),
    getSettings: () => respond(() => db.settings),
    getReadiness: () =>
      respond(() => {
        const count = db.projects.length
        return {
          ready: true,
          checks: [
            {
              id: 'harness',
              label: 'Agent runtime',
              state: 'ok',
              detail: 'Claude Code',
              fix: null,
            },
            {
              id: 'claude-auth',
              label: 'Claude login',
              state: 'ok',
              detail: 'A login or API key is set up.',
              fix: null,
            },
            { id: 'git', label: 'Git', state: 'ok', detail: 'git version 2.47.0', fix: null },
            { id: 'github', label: 'GitHub', state: 'ok', detail: 'Token from gh.', fix: null },
            count > 0
              ? {
                  id: 'projects',
                  label: 'Projects',
                  state: 'ok',
                  detail: `${count} added.`,
                  fix: null,
                }
              : {
                  id: 'projects',
                  label: 'Projects',
                  state: 'todo',
                  detail: 'No projects yet.',
                  fix: 'Add a folder or repository as a project.',
                },
          ],
        }
      }),
    updateSettings: req =>
      respond(() => {
        // like the server: tool overrides must be absolute, the editor command non-empty
        for (const p of Object.values(req.settings?.toolPaths ?? {}))
          if (p && !/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p))
            throw new Error('toolPaths must be absolute paths')
        if (req.settings?.editorCommand !== undefined && !req.settings.editorCommand.trim())
          throw new Error('editorCommand must be a non-empty command')
        if (req.settings) Object.assign(db.settings.settings, req.settings)
        if (req.pricing) db.settings.pricing = req.pricing
        return db.settings
      }),

    subscribe(listener, _onReconnect) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return api
}
