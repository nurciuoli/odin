// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ServerEvent } from '@odin/shared/events'
import { createMockApi, computeMetrics } from './mock'
import { createFixtures, FIXTURE_SESSION_IDS } from './fixtures'
import { ApiRequestError } from './types'

function withEvents() {
  const api = createMockApi()
  const events: ServerEvent[] = []
  api.subscribe(e => events.push(e))
  return { api, events }
}

describe('mock api: projects', () => {
  it('summaries count live sessions per project', async () => {
    const { api } = withEvents()
    const [odin] = await api.listProjects()
    expect(odin!.sessions).toEqual({ running: 1, waiting: 1, total: 7 })
  })

  it('registers a project by path and refuses duplicates', async () => {
    const { api, events } = withEvents()
    const p = await api.createProject({ path: '/home/me/code/New Thing' })
    expect(p.name).toBe('new-thing')
    expect(events).toContainEqual({ type: 'project.updated', project: 'new-thing' })
    await expect(api.createProject({ path: '/home/me/code/New Thing' })).rejects.toBeInstanceOf(
      ApiRequestError,
    )
  })

  it('settings overrides apply and clear', async () => {
    const { api } = withEvents()
    const p = await api.updateProjectSettings('rick', { title: 'Rick v1', repo: 'me/rick' })
    expect([p.title, p.repo]).toEqual(['Rick v1', 'me/rick'])
  })
})

describe('mock api: sessions', () => {
  it('lists newest first, hides archived by default, filters', async () => {
    const { api } = withEvents()
    const all = await api.listSessions()
    expect(all.some(s => s.archived)).toBe(false)
    expect(all.map(s => s.updatedAt)).toEqual([...all.map(s => s.updatedAt)].sort().reverse())
    const waiting = await api.listSessions({ state: ['waiting'] })
    expect(waiting.map(s => s.id)).toEqual([FIXTURE_SESSION_IDS.waiting])
    expect((await api.listSessions({ q: 'history' })).length).toBe(1)
    expect((await api.listSessions({ archived: true })).map(s => s.id)).toEqual([
      FIXTURE_SESSION_IDS.fork,
    ])
  })

  it('detail carries transcript, pending prompts, todos and artifacts', async () => {
    const { api } = withEvents()
    const w = await api.getSession(FIXTURE_SESSION_IDS.waiting)
    expect(w.pending).toHaveLength(2)
    expect(w.pending.map(p => p.kind)).toEqual(['tool', 'question'])
    expect(w.live).toBe(true)
    const r = await api.getSession(FIXTURE_SESSION_IDS.running)
    expect(r.transcript.map(e => e.kind)).toContain('thinking')
    expect(r.todos.length).toBeGreaterThan(0)
    const i = await api.getSession(FIXTURE_SESSION_IDS.idle)
    expect(i.artifacts).toHaveLength(1)
    const e = await api.getSession(FIXTURE_SESSION_IDS.ended)
    expect(e.artifacts.length).toBeGreaterThanOrEqual(2)
  })

  it('start with a message and settings makes a worktree branch', async () => {
    const { api, events } = withEvents()
    const s = await api.startSession({
      project: 'odin',
      prompt: { text: 'Work on #23: Library: install with drift' },
      model: 'opus',
      worktree: true,
    })
    expect(s.templateId).toBeNull()
    expect(s.workspace.kind).toBe('worktree')
    expect(s.branch).toMatch(/^odin\/work-on-23-library-install-with-drift-[0-9a-f]{8}$/)
    expect(s.model).toBe('opus')
    const d = await api.getSession(s.id)
    const first = d.transcript[0]!
    expect(first.kind === 'user' && first.text).toContain(
      'Work on #23: Library: install with drift',
    )
    expect(events.some(e => e.type === 'session.updated' && e.session.id === s.id)).toBe(true)
    await expect(api.startSession({ project: 'odin' })).rejects.toThrow(/prompt/)
  })

  it('answering a fixture prompt resolves it and attaches the tool result', async () => {
    const { api, events } = withEvents()
    const id = FIXTURE_SESSION_IDS.waiting
    const [req, question] = (await api.getSession(id)).pending
    await api.answerPermission(id, req!.id, { behavior: 'deny', message: 'not now' })
    // the queued question keeps the session waiting
    const mid = await api.getSession(id)
    expect(mid.pending.map(p => p.id)).toEqual([question!.id])
    expect(mid.state).toBe('waiting')
    await api.answerPermission(id, question!.id, { behavior: 'allow', scope: 'once' })
    const d = await api.getSession(id)
    expect(d.pending).toEqual([])
    expect(d.state).toBe('idle')
    const tool = d.transcript.find(e => e.id === req!.toolUseId)
    expect(tool?.kind === 'tool' && tool.result).toEqual({
      ok: false,
      text: 'not now',
      truncated: false,
    })
    expect(
      events.some(e => e.type === 'session.event' && e.event.type === 'permission.resolved'),
    ).toBe(true)
    await expect(
      api.answerPermission(id, req!.id, { behavior: 'allow', scope: 'once' }),
    ).rejects.toThrow(/no longer open/)
  })

  it('fork copies the transcript and points at its parent', async () => {
    const { api } = withEvents()
    const f = await api.forkSession(FIXTURE_SESSION_IDS.ended, { title: 'Again' })
    expect(f.parentId).toBe(FIXTURE_SESSION_IDS.ended)
    const parent = await api.getSession(FIXTURE_SESSION_IDS.ended)
    expect((await api.getSession(f.id)).transcript.length).toBe(parent.transcript.length)
  })

  it('leaves side threads out of lists and counts unless asked for', async () => {
    const { api } = withEvents()
    const aside = FIXTURE_SESSION_IDS.aside
    expect((await api.listSessions()).some(s => s.id === aside)).toBe(false)
    expect((await api.listSessions({ limit: 50 })).some(s => s.aside)).toBe(false)
    expect((await api.listSessions({ aside: true })).map(s => s.id)).toEqual([aside])
    const children = await api.listSessions({ parentId: FIXTURE_SESSION_IDS.running })
    expect(children.map(s => s.id)).toEqual([aside])
    expect(await api.listSessions({ parentId: FIXTURE_SESSION_IDS.running, aside: false })).toEqual(
      children,
    )
    const [odin] = await api.listProjects()
    expect(odin!.sessions.total).toBe(7)
  })

  it('forks a side thread with plan mode and a Side: title, in any parent state', async () => {
    const api = createMockApi({ replyDelayMs: 0 })
    const events: ServerEvent[] = []
    api.subscribe(e => events.push(e))
    const parent = FIXTURE_SESSION_IDS.waiting
    await expect(api.forkSession(parent, { aside: true })).rejects.toThrow(/prompt/)
    await expect(
      api.forkSession(parent, { aside: true, worktree: true, prompt: { text: 'q' } }),
    ).rejects.toThrow(/worktree/)
    const side = await api.forkSession(parent, {
      aside: true,
      prompt: { text: 'What does the prompt component do on Escape?' },
    })
    expect(side).toMatchObject({
      aside: true,
      parentId: parent,
      permissionMode: 'plan',
      title: 'Side: What does the prompt component do on Escape?',
    })
    expect((await api.listSessions()).some(s => s.id === side.id)).toBe(false)
    await vi.waitFor(async () => {
      const d = await api.getSession(side.id)
      expect(d.state).toBe('idle')
      expect(d.transcript.at(-1)?.kind).toBe('assistant')
    })
    const other = await api.forkSession(parent, {
      aside: true,
      prompt: { text: 'x' },
      permissionMode: 'default',
      model: 'claude-haiku-5-5',
    })
    expect([other.permissionMode, other.model]).toEqual(['default', 'claude-haiku-5-5'])
  })

  it('promotes a side thread and refuses to demote', async () => {
    const { api } = withEvents()
    const aside = FIXTURE_SESSION_IDS.aside
    await expect(api.updateSession(FIXTURE_SESSION_IDS.idle, { aside: true })).rejects.toThrow()
    const s = await api.updateSession(aside, { aside: false, title: 'Scroll position' })
    expect([s.aside, s.title]).toEqual([false, 'Scroll position'])
    expect((await api.listSessions()).some(x => x.id === aside)).toBe(true)
  })

  it('harnessEvent folds usage and turns into metrics', async () => {
    const { api } = withEvents()
    const id = FIXTURE_SESSION_IDS.idle
    const before = (await api.getSession(id)).metrics
    api.harnessEvent(id, {
      type: 'usage',
      model: 'claude-haiku-5-5',
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      cumulative: false,
      costUsd: 0.5,
      contextTokens: 10,
    })
    api.harnessEvent(id, { type: 'turn.end', durationMs: 1000, ok: true, error: null })
    const after = (await api.getSession(id)).metrics
    expect(after.tokens.output).toBe(before.tokens.output + 2)
    expect(after.turns).toBe(before.turns + 1)
    expect(after.costUsd).toBeCloseTo((before.costUsd ?? 0) + 0.5)
  })
})

describe('mock api: models', () => {
  it('returns Grok models for grok, Codex models for codex ids, and Claude otherwise', async () => {
    const { api } = withEvents()
    expect(await api.listModels('grok')).toEqual([
      expect.objectContaining({ value: 'grok-4.7', displayName: 'Grok 4.7' }),
      expect.objectContaining({
        value: 'grok-4.7-build-fast',
        displayName: 'Grok 4.7 Fast',
      }),
    ])
    expect(await api.listModels('codex')).toEqual([
      expect.objectContaining({ value: 'codex-test', displayName: 'Codex test model' }),
    ])
    expect(await api.listModels('codex-wsl')).toEqual([
      expect.objectContaining({ value: 'codex-test' }),
    ])
    expect(await api.listModels('antigravity')).toEqual([
      expect.objectContaining({ value: 'gemini-3.8-flash', displayName: 'Gemini 3.8 Flash' }),
      expect.objectContaining({ value: 'gemini-3.8-pro', displayName: 'Gemini 3.8 Pro' }),
    ])
    for (const id of ['claude', 'unknown', undefined]) {
      const models = await api.listModels(id)
      expect(models.map(m => m.value)).toEqual(['default', 'opus', 'sonnet', 'haiku'])
    }
    const settings = await api.getSettings()
    expect(settings.harnesses.map(h => h.id)).toEqual([
      'opencode',
      'claude',
      'codex',
      'grok',
      'antigravity',
    ])
  })
})

describe('mock api: library', () => {
  it('drift states follow the hashes; install refuses over a modified copy without force', async () => {
    const { api } = withEvents()
    const inst = await api.listInstallations('odin')
    expect(Object.fromEntries(inst.map(i => [i.id, i.state]))).toEqual({
      reviewer: 'update-available',
      'release-notes': 'modified',
      triage: 'current',
    })
    await expect(
      api.install('odin', { kind: 'skill', id: 'release-notes', action: 'update' }),
    ).rejects.toThrow(/changed/)
    const forced = await api.install('odin', {
      kind: 'skill',
      id: 'release-notes',
      action: 'update',
      force: true,
    })
    expect(forced.installation!.state).toBe('current')
    await expect(
      api.install('odin', { kind: 'prompt', id: 'fix-issue', action: 'install' }),
    ).rejects.toThrow(/not found|unknown kind/)
  })

  it('saving records a new version', async () => {
    const { api } = withEvents()
    await api.saveAsset('agent', 'reviewer', { 'reviewer.md': '---\nname: reviewer\n---\nNew.' })
    const d = await api.getAsset('agent', 'reviewer')
    expect(d.versions.length).toBe(3)
    expect(d.installs[0]!.state).toBe('update-available')
    await expect(api.saveAsset('agent', 'Bad Id', { 'x.md': '' })).rejects.toThrow(/invalid id/)
  })
})

describe('computeMetrics', () => {
  it('groups by dimension with medians and rates', () => {
    const rows = computeMetrics(createFixtures().sessions, { groupBy: ['model'] })
    const opus = rows.find(r => r.key.model === 'claude-opus-5-5')!
    expect(opus.n).toBe(2) // the archived fork is left out
    expect(opus.lowConfidence).toBe(true)
    expect(opus.rates.merged).toBe(1)
    expect(rows.every(r => r.sessionIds.length === r.n)).toBe(true)
    expect(() => computeMetrics([], { groupBy: ['model', 'model'] })).toThrow()
  })
  it('returns one row without grouping, and honours since and until', () => {
    const sessions = createFixtures().sessions
    const [all] = computeMetrics(sessions, { groupBy: [], project: 'odin' })
    expect(all!.key).toEqual({})
    expect(all!.total.costUsd).toBeGreaterThan(0)
    const empty = computeMetrics([], { groupBy: [] })
    expect(empty).toHaveLength(1)
    expect(empty[0]!.n).toBe(0)
    const future = new Date(Date.now() + 86_400_000).toISOString()
    expect(computeMetrics(sessions, { groupBy: [], since: future })[0]!.n).toBe(0)
    const past = new Date(Date.now() - 365 * 86_400_000).toISOString()
    expect(computeMetrics(sessions, { groupBy: [], until: past })[0]!.n).toBe(0)
  })
  it('serves up to 168 days of activity, with commits only for git folders', async () => {
    const api = createMockApi()
    expect((await api.getProjectActivity('odin', 168)).days).toHaveLength(168)
    await expect(api.getProjectActivity('odin', 169)).rejects.toThrow()
    const rick = await api.getProjectActivity('rick', 30)
    expect(rick.days.every(d => d.commits === null)).toBe(true)
    const harbor = await api.getProjectActivity('harbor', 30)
    expect(harbor.days.every(d => d.sessions === 0 && d.commits !== null)).toBe(true)
  })
})

describe('handoff', () => {
  it('previews a briefing, starts the other harness and ends the source', async () => {
    const api = createMockApi()
    const id = FIXTURE_SESSION_IDS.idle
    const source = await api.getSession(id)
    const preview = await api.handoffPreview(id, 'codex')
    expect(preview.target).toMatchObject({ harness: 'codex', available: true })
    expect(preview.brief).toContain('## Task')
    expect(preview.source.title).toBe(source.title)
    await expect(api.handoffPreview(id, source.harness)).rejects.toThrow(/different harness/)
    await expect(api.handoffPreview(id, 'nope')).rejects.toThrow(/unknown harness/)

    const next = await api.handoffSession(id, { harness: 'codex', brief: 'carry on' })
    expect(next).toMatchObject({
      harness: 'codex',
      parentId: id,
      cwd: source.cwd,
      branch: source.branch,
    })
    expect(next.handoff).toMatchObject({ from: id, harness: source.harness })
    expect((await api.getSession(id)).state).toBe('ended')
    const first = (await api.getSession(next.id)).transcript.find(e => e.kind === 'user')
    expect(first).toMatchObject({ text: 'carry on' })
  })

  it('refuses a running source and keeps the source with endSource false', async () => {
    const api = createMockApi()
    await expect(
      api.handoffSession(FIXTURE_SESSION_IDS.running, { harness: 'codex' }),
    ).rejects.toThrow(/stop the session/)
    const id = FIXTURE_SESSION_IDS.idle
    await api.handoffSession(id, { harness: 'codex', endSource: false })
    expect((await api.getSession(id)).state).toBe('idle')
  })
})
