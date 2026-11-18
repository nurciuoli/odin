// What the MCP servers screen shows for each library server: how it connects and whether it can start.
import type { LibraryAsset, McpOAuthStatus, SecretsResponse } from '@odin/shared/api'

export type AuthState =
  | { kind: 'local' }
  | { kind: 'none' }
  | { kind: 'secrets'; names: string[] }
  | { kind: 'oauth'; status: McpOAuthStatus | 'loading' | 'unknown' }
  | { kind: 'error' }

export type McpRow = {
  id: string
  name: string
  description: string
  transport: 'stdio' | 'http' | 'sse'
  /** The command line or the url, for the Target column. */
  target: string
  auth: AuthState
  /** Secrets this server needs that are not set. */
  missing: string[]
  oauth: boolean
  enabled: boolean
  /** Only the Actions column's key. */
  actions: null
}

interface Spec {
  type?: string
  command?: string
  args?: string[]
  url?: string
  headers?: Record<string, string>
  oauth?: unknown
}

export function mcpRows(
  assets: LibraryAsset[],
  secrets: SecretsResponse | null,
  oauth: Record<string, McpOAuthStatus | 'unknown'>,
): McpRow[] {
  return assets
    .filter(a => a.kind === 'mcp')
    .map(a => {
      const spec = a.meta as Spec
      const transport: McpRow['transport'] =
        spec.type === 'http' || spec.type === 'sse' ? spec.type : 'stdio'
      const missing = (secrets?.missing ?? []).filter(m => m.usedBy.includes(a.id)).map(m => m.name)
      const used = (secrets?.secrets ?? []).filter(s => s.usedBy.includes(a.id)).map(s => s.name)
      const hasOauth = transport !== 'stdio' && !!spec.oauth
      let auth: AuthState
      if (a.error) auth = { kind: 'error' }
      else if (hasOauth) auth = { kind: 'oauth', status: oauth[a.id] ?? 'loading' }
      else if (missing.length || used.length)
        auth = { kind: 'secrets', names: [...used, ...missing] }
      else if (transport === 'stdio') auth = { kind: 'local' }
      else auth = { kind: 'none' }
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        transport,
        target:
          transport === 'stdio'
            ? [spec.command, ...(spec.args ?? [])].filter(Boolean).join(' ')
            : (spec.url ?? ''),
        auth,
        missing,
        oauth: hasOauth,
        enabled: a.enabled,
        actions: null,
      }
    })
    .sort((x, y) => x.name.localeCompare(y.name))
}

/** The ids of servers that sign in with OAuth, to ask for their status. */
export const oauthIds = (rows: McpRow[]) => rows.filter(r => r.oauth).map(r => r.id)

/** True when the server will fail to start until the person does something. */
export function needsAttention(row: McpRow): boolean {
  if (!row.enabled) return false
  if (row.auth.kind === 'error' || row.missing.length) return true
  return (
    row.auth.kind === 'oauth' &&
    typeof row.auth.status === 'object' &&
    row.auth.status.state === 'needs-sign-in'
  )
}

/** Secret names are upper snake case by habit; this only checks the rule core enforces. */
export { SECRET_NAME_PATTERN as secretNamePattern } from '@odin/shared/library'
