// Decide whether a saved MCP spec should sign in with OAuth. The editor calls this before writing a version.
import type { AssetFiles, McpOAuthDetect } from '@odin/shared/api'
import { entryFile, parseJsonObject, stringify, type JsonObject } from './assetForm'

export interface PreparedMcp {
  files: AssetFiles
  /** The saved spec signs in with OAuth, so the editor may open the browser. */
  signIn: boolean
  /** OAuth was not on the spec before this prepare. */
  added: boolean
  /** The remote URL changed. */
  urlChanged: boolean
  /** Set when the probe failed. The spec is saved unchanged. */
  warning: string | null
}

const remote = (doc: JsonObject) => doc.type === 'http' || doc.type === 'sse'

function authHeader(doc: JsonObject): boolean {
  const headers = doc.headers
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false
  return Object.keys(headers).some(h => h.toLowerCase() === 'authorization')
}

function urlOf(doc: JsonObject): string {
  return typeof doc.url === 'string' ? doc.url : ''
}

/** Fill in `oauth` when a remote server publishes OAuth metadata and the spec does not already sign in. */
export async function attachMcpOAuth(
  files: AssetFiles,
  id: string,
  detect: (url: string) => Promise<McpOAuthDetect>,
): Promise<PreparedMcp> {
  const unchanged = (extra: Partial<PreparedMcp> = {}): PreparedMcp => ({
    files,
    signIn: false,
    added: false,
    urlChanged: false,
    warning: null,
    ...extra,
  })
  const name = entryFile('mcp', id)
  const text = files[name]
  if (text === undefined) return unchanged()
  const parsed = parseJsonObject(text)
  if ('error' in parsed) return unchanged()
  const doc = parsed.value
  if (!remote(doc) || !urlOf(doc).trim() || authHeader(doc)) return unchanged()
  if (doc.oauth && typeof doc.oauth === 'object') return { ...unchanged(), signIn: true }
  let found: McpOAuthDetect
  try {
    found = await detect(urlOf(doc))
  } catch (e) {
    return unchanged({
      warning: e instanceof Error ? e.message : 'Could not check whether this server needs sign-in.',
    })
  }
  if (!found.oauth) return unchanged()
  const next: JsonObject = { ...doc, oauth: {} }
  return {
    files: { ...files, [name]: stringify(next) },
    signIn: true,
    added: true,
    urlChanged: false,
    warning: null,
  }
}

/** True when the spec's remote URL differs from `previous` (the files already saved). */
export function mcpUrlChanged(previous: AssetFiles, next: AssetFiles, id: string): boolean {
  const name = entryFile('mcp', id)
  const url = (files: AssetFiles) => {
    const parsed = parseJsonObject(files[name] ?? '')
    return 'error' in parsed ? '' : urlOf(parsed.value)
  }
  return url(previous) !== url(next)
}
