import { relativePath } from '@/components/FilePath/relativePath'
import { diffLines } from '@/components/CodeBlock/diffLines'
import type { ToolCallView } from './types'

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()
const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s)

/** Grok's tool names, shown with the same verbs and targets as the other harnesses. */
const GROK_NAMES: Record<string, string> = {
  read_file: 'Read',
  search_replace: 'Edit',
  write: 'Write',
  write_file: 'Write',
  grep: 'Grep',
  glob: 'Glob',
  run_terminal_command: 'Bash',
  bash: 'Bash',
  list_dir: 'List',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  spawn_subagent: 'Agent',
  todo_write: 'Todos',
  ask_user_question: 'Question',
}

/**
 * The call as the row should show it. Grok history uses snake_case names and `target_file`; a live ACP title can be
 * `Execute \`the whole command\``. Both become the short name and the field the other formatters already understand.
 */
export function presentTool<T extends { name: string; input: Record<string, unknown> }>(
  call: T,
): T {
  const execute = /^Execute `([\s\S]+)`$/.exec(call.name)
  const name = GROK_NAMES[call.name] ?? (execute ? 'Bash' : call.name)
  const input = { ...call.input }
  let changed = name !== call.name
  if (execute && !str(input.command)) {
    input.command = execute[1]
    changed = true
  }
  if (
    (name === 'Read' || name === 'Write' || name === 'Edit' || name === 'List') &&
    !str(input.file_path)
  ) {
    const file =
      str(input.target_file) ??
      (name === 'List' ? (str(input.target_directory) ?? str(input.path)) : str(input.path))
    if (file) {
      input.file_path = file
      changed = true
    }
  }
  if (call.name === 'grep' && input.output_mode === undefined) {
    input.output_mode = 'content'
    changed = true
  }
  return changed ? { ...call, name, input } : call
}

/** `mcp__server__tool` → `server › tool`; undefined for other names. */
export function mcpLabel(name: string): string | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  return m ? `${m[1]} › ${m[2]}` : undefined
}

/** The tool's name as shown: MCP tools as `MCP` (the summary carries `server › tool`). */
export function toolTitle(name: string): string {
  const shown = GROK_NAMES[name] ?? (/^Execute `[\s\S]+`$/.test(name) ? 'Bash' : name)
  return mcpLabel(shown) ? 'MCP' : shown
}

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'List'])

/** The file a Read/Write/Edit/MultiEdit/NotebookEdit call works on, as the input gives it; undefined otherwise. */
export function toolPath(call: Pick<ToolCallView, 'name' | 'input'>): string | undefined {
  call = presentTool(call)
  if (!FILE_TOOLS.has(call.name)) return undefined
  const i = call.input
  return str(i.file_path) ?? str(i.notebook_path) ?? str(i.path)
}

const lineCount = (text: string) => text.split(/\r\n|\n|\r/).filter(l => l.trim() !== '').length

/** "+6 −2" for the Edit/Write/MultiEdit family, from the input; undefined when the input has no change in it. */
function changeMeta(call: Pick<ToolCallView, 'name' | 'input'>): string | undefined {
  call = presentTool(call)
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const count = (before: string, after: string): [number, number] => {
    const hunks = diffLines(before, after)
    let add = 0
    let del = 0
    for (const h of hunks)
      for (const l of h.lines) {
        if (l.type === 'add') add++
        else if (l.type === 'remove') del++
      }
    return [add, del]
  }
  const i = call.input
  let pairs: [string, string][] = []
  if (call.name === 'Write') {
    const content = s(i.content)
    if (content === undefined) return undefined
    pairs = [['', content]]
  } else if (call.name === 'Edit') {
    const a = s(i.old_string)
    const b = s(i.new_string)
    if (a === undefined || b === undefined) return undefined
    pairs = [[a, b]]
  } else if (call.name === 'MultiEdit' && Array.isArray(i.edits)) {
    for (const e of i.edits as Record<string, unknown>[]) {
      const a = s(e?.old_string)
      const b = s(e?.new_string)
      if (a !== undefined && b !== undefined) pairs.push([a, b])
    }
    if (!pairs.length) return undefined
  } else return undefined
  let add = 0
  let del = 0
  for (const [a, b] of pairs) {
    const [x, y] = count(a, b)
    add += x
    del += y
  }
  return del ? `+${add} −${del}` : `+${add}`
}

/**
 * The result of a finished call where it can be derived reliably (line count, `+6 −2`, file/match count);
 * undefined otherwise, so the line just shows nothing. A truncated result is never counted.
 */
export function toolMeta(
  call: Pick<ToolCallView, 'name' | 'input' | 'status' | 'result'>,
): string | undefined {
  call = presentTool(call)
  if (call.status !== 'ok') return undefined
  const change = changeMeta(call)
  if (change) return change
  const r = call.result
  if (!r || r.truncated || !r.text) return undefined
  const n = lineCount(r.text)
  switch (call.name) {
    case 'Read':
    case 'NotebookRead':
      return n ? `${n} ${n === 1 ? 'line' : 'lines'}` : undefined
    case 'Glob':
      return /^no files/i.test(r.text.trim()) ? '0 files' : `${n} ${n === 1 ? 'file' : 'files'}`
    case 'Grep': {
      const mode =
        typeof call.input.output_mode === 'string' ? call.input.output_mode : 'files_with_matches'
      if (/^no (files|matches)/i.test(r.text.trim()))
        return mode === 'content' ? '0 matches' : '0 files'
      if (mode === 'content') return `${n} ${n === 1 ? 'match' : 'matches'}`
      if (mode === 'files_with_matches') return `${n} ${n === 1 ? 'file' : 'files'}`
      return undefined
    }
    default:
      return undefined
  }
}

/**
 * A one-line summary of what the call does. Empty when the input has nothing to say. File tools summarise as their
 * path, relative to `root` when given (see relativePath).
 */
export function toolSummary(
  call: Pick<ToolCallView, 'name' | 'input'>,
  root?: string | null,
): string {
  call = presentTool(call)
  const i = call.input
  const path = toolPath(call)
  if (path !== undefined) return relativePath(path, root)
  switch (call.name) {
    case 'Bash':
      return oneLine(str(i.command) ?? '')
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return ''
    case 'Grep':
    case 'Glob':
      return str(i.pattern) ?? ''
    case 'Agent':
    case 'Task': {
      const desc = str(i.description) ?? ''
      const type = str(i.subagent_type)
      return type ? (desc ? `${desc} (${type})` : type) : desc
    }
    case 'WebFetch':
      return str(i.url) ?? ''
    case 'Todos': {
      const n = Array.isArray(i.todos) ? i.todos.length : 0
      return n ? `${n} ${n === 1 ? 'item' : 'items'}` : ''
    }
    case 'Question': {
      const first = Array.isArray(i.questions) ? i.questions[0] : undefined
      const text =
        first && typeof first === 'object'
          ? str((first as Record<string, unknown>).question)
          : undefined
      return text ? clip(oneLine(text)) : ''
    }
    default: {
      const mcp = mcpLabel(call.name)
      if (mcp) return mcp
      const preferred = [
        i.description,
        i.query,
        i.pattern,
        i.url,
        i.command,
        i.path,
        i.file_path,
        i.target_file,
        i.target_directory,
      ].find(v => str(v) !== undefined)
      const first = preferred ?? Object.values(i).find(v => str(v) !== undefined)
      return first ? clip(oneLine(first as string)) : ''
    }
  }
}
