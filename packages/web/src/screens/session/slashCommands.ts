// The session composer's `/` list: Odin's own commands (run by the web, never sent) ahead of the harness's.
import type { SlashCommand } from '@odin/shared/harness'
import type { ComposerCommand } from '@/components/Chat'

const SOURCE_GROUPS: Record<SlashCommand['source'], string> = {
  odin: 'Odin',
  builtin: 'Built-in',
  custom: 'Custom',
  library: 'Library',
}

export type OdinCommandName = 'clear' | 'model' | 'rename' | 'btw' | 'send' | 'effort'

/** Odin's commands. `/model` only where the screen has a model menu. */
export function odinCommands(opts: { model: boolean; effort?: string[] }): SlashCommand[] {
  const list: SlashCommand[] = [
    {
      name: 'clear',
      description: 'Start a new session in this project',
      argumentHint: '',
      aliases: ['reset', 'new'],
      source: 'odin',
    },
    {
      name: 'rename',
      description: 'Rename this session',
      argumentHint: '<title>',
      source: 'odin',
    },
    {
      name: 'btw',
      description: 'Ask a side question while this session keeps going',
      argumentHint: '<question>',
      source: 'odin',
    },
    {
      name: 'send',
      description: 'Send now and interrupt the current turn',
      argumentHint: '<message>',
      aliases: ['now'],
      source: 'odin',
    },
  ]
  if (opts.model)
    list.splice(1, 0, {
      name: 'model',
      description: 'Change the model',
      argumentHint: '<model>',
      source: 'odin',
    })
  if (opts.effort?.length)
    list.push({
      name: 'effort',
      description: 'Change reasoning effort for subsequent turns',
      argumentHint: '<level>',
      source: 'odin',
      choices: ['default', ...opts.effort].map(insert => ({ label: insert, insert })),
    })
  return list
}

const names = (c: SlashCommand) => [c.name, ...(c.aliases ?? [])].map(n => n.toLowerCase())

/** Odin's first; a harness command whose name or alias a Odin command claims is dropped. */
export function mergeCommands(odin: SlashCommand[], harness: SlashCommand[]): SlashCommand[] {
  const taken = new Set(odin.flatMap(names))
  const seen = new Set<string>()
  const out = [...odin]
  for (const c of harness) {
    const name = c.name.replace(/^\//, '')
    if (taken.has(name.toLowerCase()) || seen.has(name)) continue
    seen.add(name)
    out.push({ ...c, name })
  }
  return out
}

export function toComposerCommands(list: SlashCommand[]): ComposerCommand[] {
  return list.map(c => ({
    id: `${c.source}:${c.name}`,
    name: c.name,
    description: c.description || undefined,
    argumentHint: c.argumentHint || undefined,
    aliases: c.aliases,
    group: SOURCE_GROUPS[c.source],
    choices: c.choices,
    icon: c.source === 'odin' ? 'sparkle' : undefined,
  }))
}

/** A message that is one of Odin's commands (by name or alias), with its argument; null to send it as is. */
export function parseOdinCommand(
  text: string,
  odin: SlashCommand[],
): { name: OdinCommandName; arg: string } | null {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (!m) return null
  const word = m[1]!.toLowerCase()
  const cmd = odin.find(c => names(c).includes(word))
  if (!cmd) return null
  return { name: cmd.name as OdinCommandName, arg: (m[2] ?? '').trim() }
}

/** Resolves `/model <arg>` against the menu's models: id, display name or resolved id, case-insensitively. */
export function resolveModel(
  arg: string,
  models: { value: string; displayName: string; resolved?: string | null }[],
): string | null {
  const q = arg.trim().toLowerCase()
  if (!q) return null
  const hit = models.find(
    m =>
      m.value.toLowerCase() === q ||
      m.displayName.toLowerCase() === q ||
      m.resolved?.toLowerCase() === q,
  )
  return hit?.value ?? arg.trim()
}
