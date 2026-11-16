import { presentTool } from './summary'
import type { ToolCallView } from './types'

/** Display-only recognition of the executable at the beginning; never evaluates shell text. */
export function terminalShell(command: string): string | undefined {
  const executable = /^\s*(?:&\s*)?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s]+))/.exec(command)
  const name = (executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? '')
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.exe$/i, '')
    .toLowerCase()
  if (name === 'powershell' || name === 'pwsh') return 'PowerShell'
  if (name === 'cmd') return 'Cmd'
  if (name === 'bash') return 'Bash'
  if (name === 'sh') return 'sh'
  if (name === 'zsh') return 'zsh'
  return undefined
}

export function terminalView(call: Pick<ToolCallView, 'name' | 'input'>) {
  const shown = presentTool(call)
  if (!['Bash', 'PowerShell', 'Shell', 'Terminal', 'Cmd'].includes(shown.name)) return undefined
  const command = typeof shown.input.command === 'string' ? shown.input.command : ''
  const lines = command ? command.split(/\r\n|\n|\r/).length : 0
  const detectedShell = terminalShell(command)
  const shell = detectedShell ?? shown.name
  const description =
    typeof shown.input.description === 'string'
      ? shown.input.description.replace(/\s+/g, ' ').trim()
      : ''
  // Grok often copies the command into description. That repeats a long script on the row.
  const useful = description && description !== command.replace(/\s+/g, ' ').trim()
  return {
    command,
    lines,
    shell,
    summary:
      (useful ? description : '') ||
      (detectedShell ? 'Command' : lines > 1 ? 'Multiline script' : command.trim()) ||
      'Command',
  }
}
