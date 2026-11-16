// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { PermissionRequest, TranscriptEntry } from '@odin/shared/harness'
import {
  buildPerch,
  laneActivity,
  MINUTE,
  perchDescription,
  perchWord,
  QUIET_AFTER,
  quietFor,
  runningAgents,
  type PerchInput,
} from './lanes'

const NOW = Date.parse('2026-11-12T12:00:00.000Z')
const ago = (min: number) => NOW - min * MINUTE
const iso = (t: number) => new Date(t).toISOString()

const prompt = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'p1',
  sessionId: 's1',
  kind: 'tool',
  toolName: 'Bash',
  toolUseId: 't1',
  input: { command: 'npm run db:migrate' },
  title: null,
  description: null,
  canAlwaysAllow: true,
  defaultToDeny: false,
  createdAt: iso(ago(4)),
  ...over,
})

const input = (over: Partial<PerchInput> = {}): PerchInput => ({
  now: NOW,
  startedAt: iso(ago(18)),
  times: [],
  pausedSince: null,
  ...over,
})

describe('quietFor', () => {
  it('is null while something happened in the last two minutes', () => {
    expect(quietFor(input({ times: [ago(30), ago(1.9)] }))).toBeNull()
    expect(quietFor(input({ startedAt: iso(ago(1)) }))).toBeNull()
  })

  it('counts from the latest activity, live moments included', () => {
    expect(quietFor(input({ times: [ago(9), ago(4)] }))).toBe(4 * MINUTE)
    expect(quietFor(input({ times: [ago(2)] }))).toBe(QUIET_AFTER)
  })

  it('falls back to the start, ignores the future, and is never quiet while paused', () => {
    expect(quietFor(input({ startedAt: iso(ago(7)) }))).toBe(7 * MINUTE)
    expect(quietFor(input({ times: [ago(5), NOW + MINUTE] }))).toBe(5 * MINUTE)
    expect(quietFor(input({ times: [ago(9)], pausedSince: ago(6) }))).toBeNull()
  })
})

describe('perchWord', () => {
  it('says the state in words', () => {
    expect(perchWord(input({ times: [ago(0.5)] }))).toBe('Running')
    expect(perchWord(input({ times: [ago(4.5)] }))).toBe('Running · quiet 4m')
    expect(perchWord(input({ pausedSince: ago(6) }))).toBe('Paused 6m')
    expect(perchWord(input({ pausedSince: ago(0.5) }))).toBe('Paused')
    expect(perchWord(input({ startedAt: iso(ago(200)), pausedSince: ago(65) }))).toBe(
      'Paused 1h 5m',
    )
  })
})

describe('perchDescription', () => {
  it('says how long it has run, been quiet, or been paused', () => {
    expect(perchDescription(input({ times: [ago(1)] }))).toBe('Active for 18 minutes')
    expect(perchDescription(input({ times: [ago(4)] }))).toBe(
      'Started 18 minutes ago, quiet for the last 4 minutes',
    )
    expect(perchDescription(input({ startedAt: iso(ago(12)), pausedSince: ago(4) }))).toBe(
      'Started 12 minutes ago, paused for the last 4 minutes',
    )
    expect(perchDescription(input({ startedAt: iso(ago(90)), times: [ago(1)] }))).toBe(
      'Started over an hour ago, active since',
    )
  })
})

describe('runningAgents', () => {
  const agentCall = (id: string, done = false): TranscriptEntry => ({
    kind: 'tool',
    id,
    name: 'Agent',
    input: {},
    ...(done ? { result: { ok: true, text: '', truncated: false } } : {}),
    at: null,
    parentToolUseId: null,
  })
  const task = (
    taskId: string,
    state: 'running' | 'completed',
    toolUseId: string | null = null,
    kind: 'agent' | 'command' = 'agent',
  ): TranscriptEntry => ({
    kind: 'task',
    id: taskId,
    task: {
      taskId,
      runId: null,
      kind,
      label: taskId,
      state,
      toolUseId,
      parentToolUseId: null,
      childSessionId: null,
      startedAt: null,
      completedAt: null,
      observedAt: null,
    },
    at: null,
    parentToolUseId: null,
  })

  it('counts running agent tasks and open Agent calls once each', () => {
    expect(runningAgents([])).toBe(0)
    expect(
      runningAgents([
        agentCall('t1'),
        task('a1', 'running', 't1'),
        agentCall('t2'),
        task('a2', 'completed', 't2'),
        agentCall('t3'),
        agentCall('t4', true),
        task('c1', 'running', null, 'command'),
      ]),
    ).toBe(2)
  })
})

describe('laneActivity', () => {
  const tool = (name: string, input: Record<string, unknown>): TranscriptEntry => ({
    kind: 'tool',
    id: name,
    name,
    input,
    at: null,
    parentToolUseId: null,
  })

  it('names the open prompt first', () => {
    expect(laneActivity({ pending: [prompt()], transcript: [] })).toBe(
      'Wants to run npm run db:migrate',
    )
    expect(
      laneActivity({
        pending: [prompt({ kind: 'question', input: { questions: [{ question: 'Body only?' }] } })],
        transcript: [],
      }),
    ).toBe('Asks: Body only?')
  })

  it('otherwise describes the latest tool call', () => {
    expect(
      laneActivity({
        pending: [],
        transcript: [
          tool('Read', { file_path: 'a/b.ts' }),
          tool('Edit', { file_path: 'src/ArtifactPanel.vue' }),
        ],
      }),
    ).toBe('Editing ArtifactPanel.vue')
    expect(laneActivity({ pending: [], transcript: [] })).toBe('Starting')
  })

  it('abbreviates terminal commands without exposing their arguments in Home activity', () => {
    expect(
      laneActivity({
        pending: [],
        transcript: [
          tool('Bash', {
            command:
              '"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content docs/STATUS.md"',
          }),
        ],
      }),
    ).toBe('Running PowerShell command')
    expect(
      laneActivity({
        pending: [],
        transcript: [tool('exec_command', { cmd: 'npm test -- --long-output' })],
      }),
    ).toBe('Running npm command')
    expect(
      laneActivity({
        pending: [],
        transcript: [tool('run_terminal_command', { command: 'pwsh -File build.ps1' })],
      }),
    ).toBe('Running PowerShell command')
  })
})

describe('buildPerch', () => {
  const detail = {
    id: 's1',
    title: 'Hash tokens',
    state: 'running' as const,
    waitingFor: null,
    createdAt: iso(ago(12)),
    pending: [],
    transcript: [],
  }

  it('marks a waiting session paused since its oldest prompt', () => {
    const perch = buildPerch(
      {
        detail: {
          ...detail,
          state: 'waiting',
          waitingFor: 'permission',
          pending: [prompt({ id: 'p2', createdAt: iso(ago(1)) }), prompt()],
        },
        extraTimes: [ago(6)],
      },
      NOW,
    )
    expect(perch.state).toBe('paused')
    expect(perch.flock).toBe('waiting')
    expect(perch.word).toBe('Paused 4m')
    expect(perch.to).toEqual({ name: 'session', params: { id: 's1' } })
    expect(perch.description).toContain('paused for the last 4 minutes')
    expect(perch.agents).toBe(0)
  })

  it('is working while there is fresh activity and quiet after two minutes without', () => {
    const fresh = buildPerch({ detail, extraTimes: [ago(1)] }, NOW)
    expect([fresh.state, fresh.flock, fresh.word]).toEqual(['running', 'working', 'Running'])
    const quiet = buildPerch({ detail, extraTimes: [ago(3)] }, NOW)
    expect([quiet.state, quiet.flock, quiet.word]).toEqual(['quiet', 'quiet', 'Running · quiet 3m'])
  })

  it('reports subagents that are out', () => {
    const perch = buildPerch(
      {
        detail: {
          ...detail,
          transcript: [
            {
              kind: 'tool',
              id: 't1',
              name: 'Task',
              input: { description: 'Review' },
              at: iso(ago(1)),
              parentToolUseId: null,
            },
          ],
        },
      },
      NOW,
    )
    expect(perch.agents).toBe(1)
    expect(perch.description).toBe('Active for 12 minutes, 1 subagent out')
  })
})

describe('buildPerch with background work', () => {
  it('says what the background work is when the turn has ended', () => {
    const perch = buildPerch(
      {
        detail: {
          id: 's1',
          title: 'T',
          state: 'running',
          createdAt: iso(ago(30)),
          pending: [],
          waitingFor: null,
          transcript: [
            {
              kind: 'assistant',
              id: 'a',
              text: 'All done here.',
              at: iso(ago(1)),
            } as TranscriptEntry,
          ],
        },
        work: { agents: 2, commands: 0 },
      },
      NOW,
    )
    expect(perch.activity).toBe('2 agents running')
  })
})
