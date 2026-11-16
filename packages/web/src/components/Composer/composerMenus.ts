// Pure text/caret logic behind the composer's `/` command menu, its argument-choice step and the `@` file menu.
import type {
  ComposerCommand,
  ComposerCommandChoice,
  ComposerFileMatch,
} from '@/components/Chat/types'

export interface Token {
  /** what follows the trigger character, up to the caret's token end */
  query: string
  /** index of the trigger character */
  start: number
  /** index just past the token */
  end: number
}

/** The `/name` token, while the caret sits inside it ("/re|", not "/review "). */
export function slashToken(text: string, caret: number): Token | null {
  const m = /^\/(\S*)/.exec(text)
  if (!m) return null
  if (caret < 1 || caret > m[0].length) return null
  return { query: m[1] ?? '', start: 0, end: m[0].length }
}

/**
 * Commands matching `query` by name or alias prefix: name matches first, then alias matches, then (for longer
 * queries) name substrings. Within that, groups keep the order they first appear in, so a grouped menu stays grouped.
 */
export function filterCommands(commands: ComposerCommand[], query: string): ComposerCommand[] {
  const q = query.toLowerCase()
  const rank = (c: ComposerCommand) => {
    if (!q) return 0
    const name = c.name.toLowerCase()
    if (name.startsWith(q)) return 0
    if (c.aliases?.some(a => a.toLowerCase().startsWith(q))) return 1
    if (q.length > 1 && name.includes(q)) return 2
    return -1
  }
  const groups = new Map<string, number>()
  for (const c of commands) if (!groups.has(c.group ?? '')) groups.set(c.group ?? '', groups.size)
  return commands
    .map((c, i) => ({ c, i, r: rank(c) }))
    .filter(x => x.r >= 0)
    .sort(
      (a, b) =>
        groups.get(a.c.group ?? '')! - groups.get(b.c.group ?? '')! || a.r - b.r || a.i - b.i,
    )
    .map(x => x.c)
}

/** Text after choosing a command: `/name ` then whatever followed the typed token. */
export function insertCommand(
  text: string,
  token: Token,
  command: ComposerCommand,
): { text: string; caret: number } {
  const prefix = `/${command.name} `
  const rest = text.slice(token.end).replace(/^\s+/, '')
  return { text: prefix + rest, caret: prefix.length }
}

/**
 * Text after picking an argument choice. The caret goes to the end; `hint` is what to show while the user types the
 * rest (only when `insert` is empty or ends in a space, i.e. something is still expected).
 */
export function insertChoice(
  command: ComposerCommand,
  choice: ComposerCommandChoice,
): { text: string; caret: number; hint: string | null } {
  const text = `/${command.name} ${choice.insert}`
  const open = choice.insert === '' || choice.insert.endsWith(' ')
  return { text, caret: text.length, hint: open ? (choice.hint ?? null) : null }
}

/** The `@path` token around the caret: `@` at the start or after whitespace, no whitespace up to the caret. */
export function mentionToken(text: string, caret: number): Token | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)@(\S*)$/.exec(before)
  if (!m) return null
  const start = before.length - m[2]!.length - 1
  const after = /^\S*/.exec(text.slice(caret))![0]
  return { query: m[2]! + after, start, end: caret + after.length }
}

/** Text after picking a file: `@path ` (directories `@path/`, so the user can keep narrowing). */
export function insertMention(
  text: string,
  token: Token,
  match: ComposerFileMatch,
): { text: string; caret: number } {
  const ref = match.kind === 'directory' ? `@${match.path}/` : `@${match.path} `
  const rest = text.slice(token.end)
  const glue = match.kind === 'file' && rest.startsWith(' ') ? ref.slice(0, -1) : ref
  return { text: text.slice(0, token.start) + glue + rest, caret: token.start + ref.length }
}

/** Calls `run` at most once per `ms` of quiet and drops results from calls a newer one superseded. */
export function latestDebounced<A, R>(
  run: (arg: A) => Promise<R>,
  ms: number,
  onResult: (result: R, arg: A) => void,
  onError?: (error: unknown) => void,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let seq = 0
  return {
    call(arg: A) {
      clearTimeout(timer)
      const mine = ++seq
      timer = setTimeout(() => {
        run(arg).then(
          r => {
            if (mine === seq) onResult(r, arg)
          },
          e => {
            if (mine === seq) onError?.(e)
          },
        )
      }, ms)
    },
    cancel() {
      clearTimeout(timer)
      seq++
    },
  }
}
