// The composer's `!` mode: `!git status` runs in the session's folder through Odin (any harness). The results are
// shown above the message box and ride along as context with the next message.
import type { ShellRunResult } from '@odin/shared/api'

/** The command after a leading `!`; null when the text isn't shell mode (`!` alone is an empty command). */
export function parseShellCommand(text: string): string | null {
  const m = /^\s*!([\s\S]*)$/.exec(text)
  return m ? m[1]!.trim() : null
}

export interface ShellRun extends ShellRunResult {
  id: string
}

function status(r: ShellRunResult): string {
  if (r.timedOut) return 'timed out'
  return r.exitCode === 0 ? 'exit 0' : r.exitCode === null ? 'killed' : `exit ${r.exitCode}`
}

/** The text put ahead of the next message so the agent sees what the user ran. */
export function shellContext(runs: ShellRunResult[]): string {
  return runs
    .map(r => {
      const note = r.truncated ? '\n[output truncated]' : ''
      return `<shell-run cwd="${r.cwd}" status="${status(r)}">\n$ ${r.command}\n${r.output.replace(/\n$/, '')}${note}\n</shell-run>`
    })
    .join('\n\n')
}

/** `text` with the runs ahead of it; unchanged when there are none. */
export function withShellContext(text: string, runs: ShellRunResult[]): string {
  return runs.length ? `${shellContext(runs)}\n\n${text}` : text
}

export { status as shellStatus }
