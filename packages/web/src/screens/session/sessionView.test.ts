// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { SessionDetail } from '@odin/shared/api'
import type { HarnessEvent, PermissionRequest, TranscriptEntry } from '@odin/shared/harness'
import { emptyMetrics } from '@odin/shared/session'
import {
  applyActionRecord,
  applySessionEvent,
  applySessionRecord,
  artifactRef,
  buildRows,
  composerMode,
  contextWindow,
  createSessionView,
  filesChanged,
  toPermissionAnswer,
  toPromptRequest,
  type SessionView,
} from './sessionView'

function detail(o: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: 's1',
    messageQueue: { revision: 0, paused: false, messages: [] },
    harness: 'claude',
    project: 'odin',
    projects: [o.project ?? 'odin'],
    title: 'Test',
    tags: [],
    pinned: false,
    archived: false,
    origin: 'odin',
    state: 'idle',
    waitingFor: null,
    cwd: '/repo',
    workspace: { kind: 'checkout' },
    branch: 'main',
    model: 'claude-sonnet-5-5',
    permissionMode: 'default',
    agent: null,
    agentVersion: null,
    templateId: null,
    parentId: null,
    aside: false,
    pull: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    error: null,
    metrics: emptyMetrics(),
    transcript: [],
    pending: [],
    todos: [],
    artifacts: [],
    live: true,
    slashCommands: [],
    ...o,
  }
}

const fold = (events: HarnessEvent[], start: SessionView = createSessionView(detail())) =>
  events.reduce(applySessionEvent, start)

it('continues a partial entry restored from the live transcript tail', () => {
  const view = createSessionView(
    detail({
      streaming: ['partial'],
      transcript: [
        {
          kind: 'assistant',
          id: 'partial',
          text: 'Hello',
          model: null,
          at: null,
          parentToolUseId: null,
        },
      ],
    }),
  )
  const next = applySessionEvent(view, {
    type: 'delta',
    entryId: 'partial',
    kind: 'assistant',
    text: ' world',
    parentToolUseId: null,
  })
  expect(next.detail.transcript[0]).toMatchObject({ text: 'Hello world' })
})

it('keeps a background launch running through parent idle and marks it unknown on runtime exit', () => {
  const task: import('@odin/shared/harness').TaskActivity = {
    taskId: 'child',
    runId: 'run',
    kind: 'agent',
    label: 'Review',
    state: 'running',
    toolUseId: 'spawn',
    parentToolUseId: null,
    childSessionId: 'native-child',
    startedAt: null,
    completedAt: null,
    observedAt: null,
  }
  const view = fold([
    { type: 'task', task },
    { type: 'state', state: 'idle' },
  ])
  const entry = view.detail.transcript.find(e => e.kind === 'task')!
  expect(entry.kind === 'task' && entry.task.state).toBe('running')
  const ended = applySessionEvent(view, { type: 'exit', outcome: 'closed', error: null })
  const unknown = ended.detail.transcript.find(e => e.kind === 'task')!
  expect(unknown.kind === 'task' && unknown.task.state).toBe('unknown')
})

const tool = (
  id: string,
  name: string,
  input: Record<string, unknown>,
  o: Partial<Extract<TranscriptEntry, { kind: 'tool' }>> = {},
): TranscriptEntry => ({ kind: 'tool', id, name, input, at: null, parentToolUseId: null, ...o })

const request = (o: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'p1',
  sessionId: 's1',
  kind: 'tool',
  toolName: 'Bash',
  toolUseId: 't1',
  input: { command: 'npm test' },
  title: 'Claude wants to run: npm test',
  description: null,
  canAlwaysAllow: true,
  defaultToDeny: false,
  createdAt: '2026-01-01T00:00:00Z',
  ...o,
})

describe('applySessionEvent', () => {
  it('streams deltas into one entry, then the whole entry replaces it', () => {
    let v = fold([
      { type: 'delta', entryId: 'a1', kind: 'assistant', text: 'Hel', parentToolUseId: null },
      { type: 'delta', entryId: 'a1', kind: 'assistant', text: 'lo', parentToolUseId: null },
    ])
    expect(v.streaming).toEqual(['a1'])
    expect(v.detail.transcript).toMatchObject([{ kind: 'assistant', id: 'a1', text: 'Hello' }])
    v = applySessionEvent(v, {
      type: 'entry',
      entry: {
        kind: 'assistant',
        id: 'a1',
        text: 'Hello!',
        model: 'm',
        at: null,
        parentToolUseId: null,
      },
    })
    expect(v.streaming).toEqual([])
    expect(v.detail.transcript).toMatchObject([{ id: 'a1', text: 'Hello!' }])
  })

  it('ignores a late delta for an entry that is already whole', () => {
    const start = createSessionView(
      detail({
        transcript: [
          {
            kind: 'assistant',
            id: 'a1',
            text: 'Done.',
            model: null,
            at: null,
            parentToolUseId: null,
          },
        ],
      }),
    )
    const v = applySessionEvent(start, {
      type: 'delta',
      entryId: 'a1',
      kind: 'assistant',
      text: 'Done.',
      parentToolUseId: null,
    })
    expect(v).toBe(start)
  })

  it('opens and resolves prompts and tracks what the session waits for', () => {
    let v = fold([
      { type: 'state', state: 'running' },
      { type: 'permission.request', request: request({ kind: 'question' }) },
      { type: 'state', state: 'waiting' },
    ])
    expect(v.detail.pending.map(p => p.id)).toEqual(['p1'])
    expect(v.detail.state).toBe('waiting')
    expect(v.detail.waitingFor).toBe('question')
    // a repeated request frame doesn't duplicate it
    v = applySessionEvent(v, { type: 'permission.request', request: request({ kind: 'question' }) })
    expect(v.detail.pending).toHaveLength(1)
    v = fold(
      [
        { type: 'permission.resolved', requestId: 'p1', behavior: 'allow' },
        { type: 'state', state: 'running' },
      ],
      v,
    )
    expect(v.detail.pending).toEqual([])
    expect(v.detail.waitingFor).toBeNull()
  })

  it('attaches tool results, todos, model and mode changes', () => {
    const v = fold([
      { type: 'entry', entry: tool('t1', 'Bash', { command: 'ls' }) },
      {
        type: 'tool.result',
        toolUseId: 't1',
        result: { ok: true, text: 'a\nb', truncated: false },
      },
      { type: 'todos', todos: [{ content: 'x', status: 'pending' }] },
      { type: 'model', model: 'claude-opus-5-5' },
      { type: 'permission.mode', mode: 'plan' },
    ])
    expect(v.detail.transcript[0]).toMatchObject({ result: { ok: true, text: 'a\nb' } })
    expect(v.detail.todos).toHaveLength(1)
    expect(v.detail.model).toBe('claude-opus-5-5')
    expect(v.detail.permissionMode).toBe('plan')
  })

  const compact = {
    name: 'compact',
    description: 'Compact the conversation',
    argumentHint: '',
    source: 'builtin' as const,
  }
  it('keeps slash commands from init', () => {
    const v = fold([
      {
        type: 'init',
        sessionId: 's1',
        model: null,
        permissionMode: null,
        cwd: '/repo',
        tools: [],
        slashCommands: [compact],
        agents: [],
      },
    ])
    expect(v.detail.slashCommands).toEqual([compact])
  })

  it('replaces slash commands on a commands event', () => {
    const review = {
      name: 'review',
      description: 'Review',
      argumentHint: '',
      source: 'builtin' as const,
    }
    const v = fold([{ type: 'commands', slashCommands: [compact, review] }])
    expect(v.detail.slashCommands).toEqual([compact, review])
  })

  it('adds a system line for notices and a failed turn, none for a clean one', () => {
    let v = fold([
      { type: 'notice', level: 'warning', text: 'Retrying' },
      { type: 'turn.end', durationMs: 10, ok: true, error: null },
    ])
    expect(v.detail.transcript).toMatchObject([
      { kind: 'system', level: 'warning', text: 'Retrying' },
    ])
    expect(v.lastTurn).toEqual({ ok: true, error: null })
    v = applySessionEvent(v, { type: 'turn.end', durationMs: 10, ok: false, error: 'overloaded' })
    expect(v.detail.transcript).toHaveLength(2)
    expect(v.detail.transcript[1]).toMatchObject({ kind: 'system', level: 'error' })
    expect(new Set(v.detail.transcript.map(e => e.id)).size).toBe(2)
  })

  it('ends the session on exit and drops open prompts', () => {
    const v = fold([
      { type: 'permission.request', request: request() },
      { type: 'exit', outcome: 'failed', error: 'crashed' },
    ])
    expect(v.detail).toMatchObject({ state: 'failed', live: false, pending: [], error: 'crashed' })
  })
})

describe('applySessionRecord', () => {
  it('takes the record fields and keeps the conversation', () => {
    const start = createSessionView(
      detail({ transcript: [tool('t1', 'Bash', {})], pending: [request()], state: 'waiting' }),
    )
    const {
      transcript: _t,
      pending: _p,
      todos: _o,
      artifacts: _a,
      live: _l,
      slashCommands: _s,
      ...record
    } = detail()
    const v = applySessionRecord(start, { ...record, title: 'Renamed', state: 'waiting' })
    expect(v.detail.title).toBe('Renamed')
    expect(v.detail.transcript).toHaveLength(1)
    expect(v.detail.pending).toHaveLength(1)
    const idle = applySessionRecord(v, { ...record, state: 'idle' })
    expect(idle.detail.pending).toEqual([])
    expect(applySessionRecord(v, { ...record, id: 'other' })).toBe(v)
  })
})

describe('applyActionRecord', () => {
  const {
    transcript: _t,
    pending: _p,
    todos: _o,
    artifacts: _a,
    live: _l,
    slashCommands: _s,
    ...record
  } = detail()
  const waiting = createSessionView(
    detail({ state: 'waiting', waitingFor: 'permission', updatedAt: '2026-01-01T00:00:02.000Z' }),
  )

  it("drops a send's response that is older than what the stream already said", () => {
    const stale = { ...record, state: 'running' as const, updatedAt: '2026-01-01T00:00:01.000Z' }
    expect(applyActionRecord(waiting, stale)).toBe(waiting)
  })

  it('keeps the live state for a record from the same instant, takes the rest', () => {
    const same = {
      ...record,
      title: 'Renamed',
      state: 'running' as const,
      waitingFor: null,
      updatedAt: '2026-01-01T00:00:02.000Z',
    }
    const v = applyActionRecord(waiting, same)
    expect(v.detail).toMatchObject({ title: 'Renamed', state: 'waiting', waitingFor: 'permission' })
  })

  it('takes a newer record whole', () => {
    const newer = { ...record, state: 'idle' as const, updatedAt: '2026-01-01T00:00:03.000Z' }
    expect(applyActionRecord(waiting, newer).detail.state).toBe('idle')
  })
})

describe('buildRows', () => {
  const ctx = { pending: [], streaming: [], running: false, artifacts: [] }

  it('nests subagent tool calls under their Agent call and hides its own text', () => {
    const rows = buildRows(
      [
        { kind: 'user', id: 'u1', text: 'go', at: null, parentToolUseId: null },
        tool('ag', 'Agent', { description: 'explore' }),
        tool('g1', 'Grep', { pattern: 'x' }, { parentToolUseId: 'ag' }),
        {
          kind: 'assistant',
          id: 'sub',
          text: 'inner',
          model: null,
          at: null,
          parentToolUseId: 'ag',
        },
        tool('r1', 'Read', { file_path: 'a' }, { parentToolUseId: 'g1' }),
        { kind: 'assistant', id: 'a1', text: 'done', model: null, at: null, parentToolUseId: null },
      ],
      ctx,
    )
    expect(rows.map(r => r.id)).toEqual(['u1', 'ag', 'a1'])
    const agent = rows[1]!
    expect(agent.kind === 'tool' && agent.call.children?.map(c => c.id)).toEqual(['g1'])
    expect(agent.kind === 'tool' && agent.call.children?.[0]?.children?.[0]?.id).toBe('r1')
  })

  it('marks the first row of each author run as the head', () => {
    const rows = buildRows(
      [
        { kind: 'user', id: 'u1', text: 'go', at: null, parentToolUseId: null },
        { kind: 'thinking', id: 'th', text: 'hm', at: null, parentToolUseId: null },
        tool('t1', 'Bash', {}),
        { kind: 'system', id: 's', level: 'info', text: 'note', at: null, parentToolUseId: null },
        { kind: 'assistant', id: 'a1', text: 'x', model: null, at: null, parentToolUseId: null },
      ],
      ctx,
    )
    expect(rows.map(r => ('head' in r ? r.head : null))).toEqual([true, true, false, null, true])
  })

  it('gives each tool call a status from its result, an open prompt or the live state', () => {
    const entries = [
      tool('ok', 'Bash', {}, { result: { ok: true, text: '', truncated: false } }),
      tool('bad', 'Bash', {}, { result: { ok: false, text: 'no', truncated: false } }),
      tool('ask', 'Bash', {}),
      tool('run', 'Bash', {}),
    ]
    const statuses = (running: boolean) =>
      buildRows(entries, { ...ctx, running, pending: [request({ toolUseId: 'ask' })] }).map(r =>
        r.kind === 'tool' ? r.call.status : null,
      )
    expect(statuses(true)).toEqual(['ok', 'failed', 'awaiting', 'running'])
    expect(statuses(false)).toEqual(['ok', 'failed', 'awaiting', 'cancelled'])
  })

  it('flags streaming entries and finds artifacts posted by tool calls', () => {
    const rows = buildRows(
      [
        { kind: 'assistant', id: 'a1', text: 'x', model: null, at: null, parentToolUseId: null },
        tool(
          'p',
          'mcp__odin__post_artifact',
          { title: 'Layouts' },
          { result: { ok: true, text: 'Posted artifact 3 v2', truncated: false } },
        ),
      ],
      { ...ctx, streaming: ['a1'] },
    )
    expect(rows[0]).toMatchObject({ kind: 'assistant', streaming: true })
    expect(rows[1]).toMatchObject({ artifact: { id: 3, version: 2, title: 'Layouts' } })
  })
})

describe('helpers', () => {
  it('artifactRef ignores other tools and failed posts', () => {
    const failed = tool(
      'p',
      'mcp__odin__post_artifact',
      {},
      { result: { ok: false, text: 'Posted artifact 1 v1', truncated: false } },
    ) as Extract<TranscriptEntry, { kind: 'tool' }>
    expect(artifactRef(failed, [])).toBeNull()
    const other = tool(
      'b',
      'Bash',
      {},
      { result: { ok: true, text: 'Posted artifact 1 v1', truncated: false } },
    ) as Extract<TranscriptEntry, { kind: 'tool' }>
    expect(artifactRef(other, [])).toBeNull()
  })

  it('filesChanged lists Edit/Write paths once, in order', () => {
    expect(
      filesChanged([
        tool('1', 'Write', { file_path: 'a.ts' }),
        tool('2', 'Read', { file_path: 'b.ts' }),
        tool('3', 'Edit', { file_path: 'c.ts' }),
        tool(
          '4',
          'Edit',
          { file_path: 'a.ts' },
          { result: { ok: false, text: '', truncated: false } },
        ),
      ]),
    ).toEqual([
      { path: 'a.ts', edits: 2, failed: true },
      { path: 'c.ts', edits: 1, failed: false },
    ])
  })

  it('filesChanged does not count a denied or interrupted edit as failed', () => {
    expect(
      filesChanged([
        tool(
          '1',
          'Edit',
          { file_path: 'a.ts' },
          { result: { ok: false, status: 'denied', text: 'Denied', truncated: false } },
        ),
      ]),
    ).toEqual([{ path: 'a.ts', edits: 1, failed: false }])
  })

  it('contextWindow is 200k unless the model is a 1M variant', () => {
    expect(contextWindow('claude-sonnet-5-5')).toBe(200_000)
    expect(contextWindow(null)).toBe(200_000)
    expect(contextWindow('claude-sonnet-5-5[1m]')).toBe(1_000_000)
  })

  it('composerMode disables while waiting and queues while running', () => {
    expect(composerMode('waiting', false)).toMatchObject({ disabled: true })
    expect(composerMode('running', false)).toMatchObject({ disabled: false, queued: true })
    expect(composerMode('idle', true)).toMatchObject({ disabled: true })
    expect(composerMode('idle', false)).toEqual({ disabled: false, queued: false, reason: null })
  })
})

describe('prompt mapping', () => {
  it('maps a tool prompt, with an edit as a diff', () => {
    const r = toPromptRequest(
      request({
        toolName: 'Edit',
        input: { file_path: 'a.ts', old_string: 'one', new_string: 'two' },
        canAlwaysAllow: false,
        defaultToDeny: true,
      }),
    )
    expect(r).toMatchObject({
      kind: 'tool',
      tool: 'Edit',
      canAlwaysAllow: false,
      defaultToDeny: true,
    })
    const lines = r.diff?.flatMap(h => h.lines.map(l => `${l.type}:${l.content}`))
    expect(lines).toEqual(['remove:one', 'add:two'])
  })

  it('renders Codex unified file changes as numbered approval diffs', () => {
    const prompt = toPromptRequest(
      request({
        toolName: 'Edit',
        input: { changes: [{ path: 'app.ts', diff: '@@ -1,1 +1,1 @@\n-before\n+after\n' }] },
      }),
    )
    expect(prompt.diff?.[0]?.lines).toEqual([
      { type: 'remove', content: 'before', oldNum: 1 },
      { type: 'add', content: 'after', newNum: 1 },
    ])
  })

  it('maps a plan and questions from the input', () => {
    expect(
      toPromptRequest(
        request({ kind: 'plan', toolName: 'ExitPlanMode', input: { plan: '1. do' }, title: null }),
      ),
    ).toMatchObject({
      kind: 'plan',
      plan: '1. do',
      title: 'The agent has a plan for you to review',
    })
    const q = toPromptRequest(
      request({
        kind: 'question',
        toolName: 'AskUserQuestion',
        input: {
          questions: [
            {
              question: 'Which layout?',
              header: 'Layout',
              multiSelect: false,
              options: [{ label: 'A', description: 'table' }, { label: 'B' }],
            },
          ],
        },
      }),
    )
    expect(q.questions).toEqual([
      {
        question: 'Which layout?',
        header: 'Layout',
        options: [{ label: 'A', description: 'table' }, { label: 'B' }],
      },
    ])
  })

  it('puts question answers into updatedInput next to the questions', () => {
    const req = request({ kind: 'question', input: { questions: [{ question: 'Q?' }] } })
    expect(
      toPermissionAnswer({ behavior: 'allow', scope: 'once', answers: { 'Q?': 'A' } }, req),
    ).toEqual({
      behavior: 'allow',
      scope: 'once',
      updatedInput: { questions: [{ question: 'Q?' }], answers: { 'Q?': 'A' } },
    })
    expect(toPermissionAnswer({ behavior: 'allow', scope: 'project' }, request())).toEqual({
      behavior: 'allow',
      scope: 'project',
    })
    expect(toPermissionAnswer({ behavior: 'deny', message: 'no' }, request())).toEqual({
      behavior: 'deny',
      message: 'no',
    })
    expect(toPermissionAnswer({ behavior: 'deny' }, request())).toEqual({ behavior: 'deny' })
  })
})
