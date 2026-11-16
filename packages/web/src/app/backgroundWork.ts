// Background work: subagents and commands still running after a turn has ended. The session list only carries the
// server's state (idle once the turn is over), so the client reads the same task entries the Activity list and the
// details panel's Background tasks read (`activityTasks`) and counts the running ones. One definition, used by the
// sessions store (sidebar, Home), the session header and Home's status text.
import type { TaskActivity, TranscriptEntry } from '@odin/shared/harness'
import { activityTasks } from '@/screens/session/activity'

export interface WorkCount {
  /** Running subagents. */
  agents: number
  /** Running commands (background processes). */
  commands: number
}

export const NO_WORK: WorkCount = { agents: 0, commands: 0 }

export const workTotal = (w: WorkCount | undefined | null) => (w ? w.agents + w.commands : 0)

/** Running tasks only: exited commands and finished agents are never live work. */
export function countWork(tasks: Pick<TaskActivity, 'kind' | 'state'>[]): WorkCount {
  let agents = 0
  let commands = 0
  for (const t of tasks) {
    if (t.state !== 'running') continue
    if (t.kind === 'agent') agents++
    else commands++
  }
  return { agents, commands }
}

export const workFromTranscript = (entries: TranscriptEntry[]): WorkCount =>
  countWork(activityTasks(entries))

/** "2 agents running", "1 background command running", "1 agent and 2 commands running". */
export function describeWork(w: WorkCount): string {
  const agents = w.agents ? `${w.agents} ${w.agents === 1 ? 'agent' : 'agents'}` : ''
  if (!w.commands) return agents ? `${agents} running` : ''
  if (!w.agents)
    return `${w.commands} background ${w.commands === 1 ? 'command' : 'commands'} running`
  return `${agents} and ${w.commands} ${w.commands === 1 ? 'command' : 'commands'} running`
}
