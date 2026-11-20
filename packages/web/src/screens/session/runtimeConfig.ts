// What the Details pane counts as configured: skills and MCP servers turned on for the project, plus anything the
// harness catalog reports. A server that still needs sign-in or a secret, or that the runtime says is down, is the
// warning dot.
import type { AgentContextItem, NativeCatalog, ProjectAgentContext } from '@odin/shared/api'
import type { McpRow } from '@/screens/mcp/mcpModel'

export type ConfigHealth = 'ok' | 'warn' | 'muted'

export interface ConfigEntry {
  id: string
  name: string
  /** Status, or a skill's description. */
  detail: string
  ok: boolean
}

export interface ConfigGroup {
  entries: ConfigEntry[]
  /** Muted while a sign-in check is in flight, or when nothing is configured. */
  health: ConfigHealth
  summary: string
}

/** Project files win. Globals that this project turned off, or that a project file replaces, stay out. */
export function activeItems(
  context: ProjectAgentContext,
  kind: 'mcp' | 'skill',
): AgentContextItem[] {
  const project = context.project.filter(item => item.kind === kind && item.enabled)
  const ids = new Set(project.map(item => item.id))
  const global = context.global.filter(
    item =>
      item.kind === kind &&
      item.enabled &&
      item.libraryEnabled &&
      !item.overridden &&
      !ids.has(item.id),
  )
  return [...project, ...global].sort((a, b) => a.name.localeCompare(b.name))
}

const CATALOG_OK = /^(connected|ok|ready|enabled)$/i

export function catalogOk(status: string): boolean {
  return CATALOG_OK.test(status.trim())
}

function mcpState(
  item: AgentContextItem,
  row: McpRow | undefined,
): { detail: string; ok: boolean; pending: boolean } {
  if (item.error || row?.auth.kind === 'error')
    return { detail: 'error', ok: false, pending: false }
  if (!row) return { detail: 'connected', ok: true, pending: false }
  const auth = row.auth
  if (auth.kind === 'oauth') {
    if (auth.status === 'loading') return { detail: 'checking', ok: true, pending: true }
    if (auth.status === 'unknown') return { detail: "can't tell", ok: false, pending: false }
    if (auth.status.state === 'needs-sign-in')
      return { detail: 'needs sign-in', ok: false, pending: false }
    return { detail: 'connected', ok: true, pending: false }
  }
  if (row.missing.length) return { detail: 'missing secret', ok: false, pending: false }
  return { detail: 'connected', ok: true, pending: false }
}

function withCatalog(entry: ConfigEntry, status: string | undefined): ConfigEntry {
  if (!status) return entry
  if (catalogOk(status)) return entry
  return { ...entry, ok: false, detail: status.trim().replaceAll('_', ' ') }
}

function summarize(entries: ConfigEntry[], pending: boolean, empty: string, ready: string): string {
  if (!entries.length) return empty
  const bad = entries.filter(entry => !entry.ok)
  if (pending && !bad.length) return `${entries.length} configured`
  if (!bad.length) return `${entries.length} ${ready}`
  if (bad.length === 1) return `${entries.length} configured · ${bad[0]!.detail}`
  return `${entries.length} configured · ${bad.length} need attention`
}

function healthOf(entries: ConfigEntry[], pending: boolean): ConfigHealth {
  if (!entries.length || (pending && entries.every(entry => entry.ok))) return 'muted'
  return entries.some(entry => !entry.ok) ? 'warn' : 'ok'
}

export function mcpGroup(
  items: AgentContextItem[],
  rows: McpRow[],
  catalog: NativeCatalog['mcp'] | null,
): ConfigGroup {
  const byId = new Map(rows.map(row => [row.id, row]))
  let pending = false
  const entries: ConfigEntry[] = items.map(item => {
    const state = mcpState(item, byId.get(item.id))
    pending ||= state.pending
    const entry: ConfigEntry = { id: item.id, name: item.name, detail: state.detail, ok: state.ok }
    const reported = catalog?.find(
      server => server.name.toLowerCase() === item.name.toLowerCase() || server.name === item.id,
    )
    return withCatalog(entry, reported?.status)
  })
  const known = new Set(
    entries.flatMap(entry => [entry.id.toLowerCase(), entry.name.toLowerCase()]),
  )
  for (const server of catalog ?? []) {
    if (known.has(server.name.toLowerCase())) continue
    const ok = catalogOk(server.status)
    entries.push({
      id: server.name,
      name: server.name,
      detail: ok ? 'connected' : server.status.trim().replaceAll('_', ' '),
      ok,
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return {
    entries,
    health: healthOf(entries, pending),
    summary: summarize(entries, pending, 'None configured', 'configured · all connected'),
  }
}

export function skillGroup(
  items: AgentContextItem[],
  catalog: NativeCatalog['skills'] | null,
): ConfigGroup {
  const entries: ConfigEntry[] = items.map(item => ({
    id: item.id,
    name: item.name,
    detail: item.error ? 'error' : item.description || 'set up',
    ok: !item.error,
  }))
  const known = new Set(
    entries.flatMap(entry => [entry.id.toLowerCase(), entry.name.toLowerCase()]),
  )
  for (const skill of catalog ?? []) {
    if (known.has(skill.name.toLowerCase())) continue
    entries.push({
      id: skill.name,
      name: skill.name,
      detail: skill.description || 'set up',
      ok: true,
    })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  const bad = entries.filter(entry => !entry.ok).length
  const summary = !entries.length
    ? 'None set up'
    : bad === 0
      ? `${entries.length} set up`
      : bad === 1
        ? `${entries.length} set up · 1 error`
        : `${entries.length} set up · ${bad} errors`
  return { entries, health: healthOf(entries, false), summary }
}
