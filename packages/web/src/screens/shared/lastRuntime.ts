import type { PermissionMode } from '@odin/shared/api'

const key = 'odin:last-runtime'

/**
 * Never carried over to a new session: turning every check off stays a choice made per session, not a default
 * picked up from the last one.
 */
const NOT_REMEMBERED: readonly PermissionMode[] = ['bypassPermissions']

export interface LastRuntime {
  harness?: string
  models: Record<string, string>
  modes: Record<string, PermissionMode>
}

function strings(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v
  return out
}

export function lastRuntime(): LastRuntime {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return {
      harness: typeof value.harness === 'string' ? value.harness : undefined,
      models: strings(value.models),
      modes: strings(value.modes) as Record<string, PermissionMode>,
    }
  } catch {
    return { models: {}, modes: {} }
  }
}

/** Remembers the harness last used and, when given, its model and permission mode. */
export function rememberRuntime(
  harness: string,
  settings: { model?: string; permissionMode?: PermissionMode } = {},
) {
  try {
    const previous = lastRuntime()
    // '' is a choice too: the runtime's default model.
    const models =
      settings.model !== undefined
        ? { ...previous.models, [harness]: settings.model }
        : previous.models
    const modes = { ...previous.modes }
    if (settings.permissionMode && !NOT_REMEMBERED.includes(settings.permissionMode))
      modes[harness] = settings.permissionMode
    localStorage.setItem(key, JSON.stringify({ harness, models, modes }))
  } catch {
    // Storage can be unavailable; session settings still persist on the server.
  }
}
