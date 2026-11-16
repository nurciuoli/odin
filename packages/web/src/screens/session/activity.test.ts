// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { TaskActivity } from '@odin/shared/harness'
import { taskKey } from '@odin/shared/harness'
import { visibleActivity, taskTime, activityLabel } from './activity'
const now = Date.parse('2026-11-12T12:00:00Z')
const task = (patch: Partial<TaskActivity> = {}): TaskActivity => ({
  taskId: 'a',
  runId: null,
  kind: 'agent',
  label: 'Review',
  state: 'running',
  toolUseId: null,
  parentToolUseId: null,
  childSessionId: null,
  startedAt: null,
  completedAt: null,
  observedAt: null,
  ...patch,
})
describe('activity visibility', () => {
  it('only includes currently running commands, even when terminal rows are focused', () => {
    const tasks = ['running', 'completed', 'failed', 'stopped', 'unknown'].map(state =>
      task({
        taskId: state,
        kind: 'command',
        state: state as TaskActivity['state'],
        completedAt: new Date(now).toISOString(),
      }),
    )
    for (const focused of tasks)
      expect(visibleActivity(tasks, now, new Set(), taskKey(focused)).map(t => t.taskId)).toEqual([
        'running',
      ])
  })
  it('keeps long generated shell source out of the activity label', () => {
    expect(
      activityLabel(
        task({
          kind: 'command',
          label: 'powershell.exe -NoProfile -Command "Get-Content long-script.ps1"',
        }),
      ),
    ).toBe('PowerShell command')
    expect(activityLabel(task({ kind: 'command', label: 'npm run dev:web' }))).toBe(
      'npm run dev:web',
    )
    expect(activityLabel(task({ label: 'a'.repeat(200) })).length).toBeLessThanOrEqual(96)
  })
  it('expires known successful/stopped completion but retains failures and unknown completion times', () => {
    const old = new Date(now - 300_001).toISOString()
    const tasks = [
      task({ taskId: 'done', state: 'completed', completedAt: old }),
      task({ taskId: 'stop', state: 'stopped', completedAt: old }),
      task({ taskId: 'fail', state: 'failed', completedAt: old }),
      task({ taskId: 'missing', state: 'completed' }),
    ]
    expect(visibleActivity(tasks, now, new Set()).map(t => t.taskId)).toEqual(['fail', 'missing'])
    expect(
      visibleActivity(tasks, now, new Set(), taskKey(tasks[0]!)).some(t => t.taskId === 'done'),
    ).toBe(true)
  })
  it('orders active work first and treats resumed runs separately for dismissal', () => {
    const first = task({ runId: 'one', state: 'failed' })
    const resumed = task({ runId: 'two' })
    expect(visibleActivity([first, resumed], now, new Set([taskKey(first)]))).toEqual([resumed])
  })
  it('never fabricates elapsed time from observation timestamps or unknown liveness', () => {
    expect(taskTime(task({ observedAt: new Date(now - 1000).toISOString() }), now)).toBe('')
    expect(
      taskTime(task({ state: 'unknown', startedAt: new Date(now - 1000).toISOString() }), now),
    ).toBe('')
  })
})
