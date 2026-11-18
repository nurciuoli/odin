// The pure side of the Library screens: kind labels, markdown frontmatter, JSON specs, starter files, validation, and
// the reusable skill a session turns into. No Vue in here, so it is easy to test.
import type {
  AssetFiles,
  AssetKind,
  DriftState,
  McpServerSpec,
  PermissionMode,
  SettingsProfileSpec,
  Workspace,
} from '@odin/shared/api'
import type { TranscriptEntry } from '@odin/shared/harness'
import { ASSET_ID_PATTERN, LIBRARY_LAYOUT, promptVariables } from '@odin/shared/library'
import type { Intent } from '@/styles/status'

export const KIND_INFO: Record<AssetKind, { label: string; plural: string }> = {
  instruction: { label: 'AGENTS.md', plural: 'AGENTS.md' },
  agent: { label: 'Agent', plural: 'Agents' },
  skill: { label: 'Skill', plural: 'Skills' },
  command: { label: 'Command', plural: 'Commands' },
  prompt: { label: 'Prompt', plural: 'Prompts' },
  template: { label: 'Template', plural: 'Templates' },
  mcp: { label: 'MCP server', plural: 'MCP servers' },
  settings: { label: 'Settings profile', plural: 'Settings profiles' },
  plugin: { label: 'Plugin', plural: 'Plugins' },
}

/** The kind's name in running text: "agent", "settings profile", "MCP server". */
export const kindNoun = (kind: AssetKind): string =>
  kind === 'mcp' ? 'MCP server' : KIND_INFO[kind].label.toLowerCase()

export const MARKDOWN_KINDS: AssetKind[] = ['instruction', 'agent']
export const JSON_KINDS: AssetKind[] = ['mcp', 'settings']

export const DRIFT_DISPLAY: Record<DriftState, { intent: Intent; label: string; hint: string }> = {
  current: { intent: 'positive', label: 'Current', hint: 'Matches the library.' },
  'update-available': {
    intent: 'info',
    label: 'Update available',
    hint: 'The library has a newer version.',
  },
  modified: {
    intent: 'warning',
    label: 'Modified in project',
    hint: 'The project copy was edited.',
  },
  conflict: {
    intent: 'danger',
    label: 'Conflict',
    hint: 'Both the project copy and the library changed.',
  },
  missing: { intent: 'neutral', label: 'Missing', hint: 'The file is gone from the project.' },
}

export function isAssetKind(value: string): value is AssetKind {
  return ['instruction', 'skill', 'agent', 'mcp', 'settings', 'plugin'].includes(value)
}

/** The file that holds an asset's main content: `<id>.md`, `<id>.json`, or a skill's `SKILL.md`. */
export function entryFile(kind: AssetKind, id: string): string {
  const layout = LIBRARY_LAYOUT[kind]
  return layout.shape === 'folder' ? layout.entry : `${id}${layout.entry}`
}

export function idError(id: string, taken: string[] = []): string | null {
  if (!id) return 'Give it an id.'
  if (!ASSET_ID_PATTERN.test(id))
    return 'Use lowercase letters, digits and hyphens, starting with a letter or digit (up to 64).'
  if (taken.includes(id)) return `There is already one called "${id}".`
  return null
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
}

// ── markdown with frontmatter ───────────────────────────────────────────────

export interface Markdown {
  fields: Record<string, string>
  body: string
}

/** `---` fenced `key: value` lines, then the body. Text without frontmatter is all body. */
export function parseMarkdown(text: string): Markdown {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line)
    if (kv) fields[kv[1]!] = kv[2]!.trim()
  }
  return { fields, body: m[2]!.replace(/^\r?\n/, '') }
}

/** Fields are written in the given order, empty ones left out; the body follows after a blank line. */
export function buildMarkdown(fields: [string, string][], body: string): string {
  const lines = fields.filter(([, v]) => v.trim() !== '').map(([k, v]) => `${k}: ${v.trim()}`)
  const head = lines.length ? `---\n${lines.join('\n')}\n---\n\n` : ''
  return `${head}${body.replace(/^\n+/, '').replace(/\s+$/, '')}\n`
}

export const MARKDOWN_FIELDS: Record<'agent' | 'command' | 'prompt', string[]> = {
  agent: ['name', 'description', 'tools', 'model'],
  command: ['name', 'description'],
  prompt: ['name', 'description'],
}

// ── JSON specs ──────────────────────────────────────────────────────────────

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
  'auto',
]

export type JsonObject = Record<string, unknown>

export function parseJsonObject(text: string): { value: JsonObject } | { error: string } {
  try {
    const v: unknown = JSON.parse(text)
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      return { error: 'Expected a JSON object.' }
    return { value: v as JsonObject }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

export const stringify = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** Problems with any JSON kind's spec; empty means it can be saved. */
export function specProblems(kind: AssetKind, raw: JsonObject): string[] {
  const out: string[] = []
  if (typeof raw.name !== 'string' || !raw.name.trim()) out.push('Give it a name.')
  if (kind === 'mcp') {
    if (raw.type === 'http' || raw.type === 'sse') {
      if (typeof raw.url !== 'string' || !raw.url.trim()) out.push('A remote server needs a URL.')
    } else if (typeof raw.command !== 'string' || !raw.command.trim()) {
      out.push('A stdio server needs a command.')
    }
  }
  return out
}

export type McpDoc = { name: string; description: string } & Partial<McpServerSpec> & {
    command?: string
    url?: string
    args?: string[]
    env?: Record<string, string>
    headers?: Record<string, string>
  }
export type SettingsDoc = { name: string; description: string } & SettingsProfileSpec

/** `KEY=value` lines ⇄ a string map. */
export function parsePairs(text: string, sep = '='): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf(sep)
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim()
  }
  return out
}
export const pairsText = (map: Record<string, string> | undefined, sep = '='): string =>
  Object.entries(map ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join('\n')
export const parseLines = (text: string): string[] =>
  text
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)

// ── starters ────────────────────────────────────────────────────────────────

export function starterFiles(
  kind: AssetKind,
  id: string,
  name: string,
  description: string,
): AssetFiles {
  const file = entryFile(kind, id)
  switch (kind) {
    case 'instruction':
      return { [file]: '# Project instructions\n\nDescribe how the default agent should work.\n' }
    case 'agent':
      return {
        [file]: buildMarkdown(
          [
            ['name', id],
            ['description', description || name],
          ],
          'You are a helpful agent. Describe how it should work here.',
        ),
      }
    case 'skill':
      return {
        [file]: buildMarkdown(
          [
            ['name', id],
            ['description', description || name],
          ],
          'Say what this skill does and when to use it.',
        ),
      }
    case 'command':
    case 'prompt':
    case 'template':
      throw new Error('Use instructions, skills or subagents instead of legacy launch assets.')
    case 'mcp':
      return {
        [file]: stringify({ name, description, type: 'stdio', command: 'npx', args: [] }),
      }
    case 'settings':
      return { [file]: stringify({ name, description, permissions: { allow: [], deny: [] } }) }
    case 'plugin':
      return { [file]: stringify({ name, description, version: '0.1.0', includes: [] }) }
  }
}

export function promptVariablesOf(files: AssetFiles): string[] {
  return promptVariables(Object.values(files).join('\n'))
}

// ── from a session ──────────────────────────────────────────────────────────

export interface SessionSource {
  harness?: string
  /** Lets "Save to library" tell a project agent from a library one (sessions store the bare agent name). */
  project?: string
  title: string
  tags: string[]
  model: string | null
  permissionMode: PermissionMode | null
  agent: string | null
  workspace: Workspace
  transcript: TranscriptEntry[]
}

export function firstMessage(s: Pick<SessionSource, 'transcript'>): string {
  const first = s.transcript.find(e => e.kind === 'user' && e.parentToolUseId === null)
  return first && first.kind === 'user' ? first.text.trim() : ''
}

/** Save reusable task text as a skill, without runtime settings. */
export function skillFromSession(
  s: SessionSource,
  id: string,
  name: string,
  description: string,
): AssetFiles {
  return {
    'SKILL.md': buildMarkdown(
      [
        ['name', id],
        ['description', description || name],
      ],
      firstMessage(s),
    ),
  }
}
