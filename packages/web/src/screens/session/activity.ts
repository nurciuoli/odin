import type { TaskActivity, TranscriptEntry } from '@odin/shared/harness'
import { taskKey } from '@odin/shared/harness'
import { statusLabel, type Status } from '@/styles/status'

export const RECENT_TASK_MS = 5 * 60_000
/** Keep generated shell invocations in the preview, where the full command can be read. */
export function activityLabel(task: TaskActivity): string {
  const label = task.label.replace(/\s+/g, ' ').trim()
  if (
    task.kind === 'command' &&
    /(?:^|[\\/\s"'])(?:powershell|pwsh)(?:\.exe)?(?:\s|$|["'])/i.test(label)
  )
    return 'PowerShell command'
  if (task.kind === 'command' && /(?:^|[\\/\s"'])cmd(?:\.exe)?\s+\/c\b/i.test(label))
    return 'Command prompt'
  return label.length > 96 ? `${label.slice(0, 93)}…` : label
}
export function activityTasks(entries: TranscriptEntry[]): TaskActivity[] {
  return entries.flatMap(entry => (entry.kind === 'task' ? [entry.task] : []))
}
export function taskStatus(
  state: TaskActivity['state'],
): Extract<Status, 'running' | 'ok' | 'failed' | 'cancelled' | 'idle'> {
  return {
    running: 'running',
    completed: 'ok',
    failed: 'failed',
    stopped: 'cancelled',
    unknown: 'idle',
  }[state] as Extract<Status, 'running' | 'ok' | 'failed' | 'cancelled' | 'idle'>
}
export function taskStateLabel(task: TaskActivity): string {
  return task.state === 'unknown'
    ? 'Unknown'
    : task.state === 'stopped'
      ? 'Stopped'
      : statusLabel[taskStatus(task.state)]
}
export function visibleActivity(
  tasks: TaskActivity[],
  now: number,
  dismissed: Set<string>,
  focused: string | null = null,
): TaskActivity[] {
  return tasks
    .filter(task => {
      // Terminal activity is strictly live. Focus and recency never retain exited commands.
      if (task.kind === 'command' && task.state !== 'running') return false
      const key = taskKey(task)
      if (key === focused) return true
      if (dismissed.has(key)) return false
      if (task.state !== 'completed' && task.state !== 'stopped') return true
      const completed = task.completedAt ? Date.parse(task.completedAt) : NaN
      return !Number.isFinite(completed) || now - completed < RECENT_TASK_MS
    })
    .sort((a, b) => {
      const active = (t: TaskActivity) => t.state === 'running' || t.state === 'unknown'
      if (active(a) !== active(b)) return active(a) ? -1 : 1
      if (active(a))
        return (Date.parse(a.startedAt ?? '') || 0) - (Date.parse(b.startedAt ?? '') || 0)
      return (Date.parse(b.completedAt ?? '') || 0) - (Date.parse(a.completedAt ?? '') || 0)
    })
}
export function taskTime(task: TaskActivity, now: number): string {
  const start = task.startedAt ? Date.parse(task.startedAt) : NaN
  const end = task.completedAt ? Date.parse(task.completedAt) : NaN
  if (Number.isFinite(end)) {
    const minutes = Math.floor(Math.max(0, now - end) / 60_000)
    return minutes ? `${minutes}m ago` : 'just finished'
  }
  if (!Number.isFinite(start) || task.state !== 'running') return ''
  const seconds = Math.floor(Math.max(0, now - start) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
