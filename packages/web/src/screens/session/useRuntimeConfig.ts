// Loads the project's configured skills and MCP servers for the Details rows, then fills in sign-in state.
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { NativeCatalog } from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import { useApi } from '@/api'
import { mcpRows, oauthIds } from '@/screens/mcp/mcpModel'
import { useServerEvents } from '@/screens/shared/useResource'
import { activeItems, mcpGroup, skillGroup, type ConfigGroup } from './runtimeConfig'

export function useRuntimeConfig(project: Ref<string>, harness: Ref<string>) {
  const api = useApi()
  const mcp = ref<ConfigGroup | null>(null)
  const skills = ref<ConfigGroup | null>(null)
  let latest = 0
  let stopped = false

  async function load() {
    const id = ++latest
    const name = project.value
    const runtime = harness.value
    const [context, library, secrets, catalog] = await Promise.all([
      api.getAgentContext(name).catch(() => null),
      api.listLibrary('mcp').catch(() => []),
      api.listSecrets().catch(() => null),
      api.getNativeCatalog(runtime, name).catch(() => null as NativeCatalog | null),
    ])
    if (stopped || id !== latest || !context) return
    const items = activeItems(context, 'mcp')
    const rows = mcpRows(library, secrets, {})
    mcp.value = mcpGroup(items, rows, catalog?.mcp ?? null)
    skills.value = skillGroup(activeItems(context, 'skill'), catalog?.skills ?? null)
    const ids = oauthIds(rows.filter(row => items.some(item => item.id === row.id)))
    if (!ids.length) return
    const oauth: Record<string, import('@odin/shared/api').McpOAuthStatus | 'unknown'> = {}
    await Promise.all(
      ids.map(async serverId => {
        try {
          oauth[serverId] = await api.getMcpOAuth(serverId)
        } catch {
          oauth[serverId] = 'unknown'
        }
      }),
    )
    if (stopped || id !== latest) return
    mcp.value = mcpGroup(items, mcpRows(library, secrets, oauth), catalog?.mcp ?? null)
  }

  watch([project, harness], () => void load(), { immediate: true })
  function onEvent(event: ServerEvent) {
    if (
      event.type === 'library.updated' ||
      (event.type === 'project.updated' && event.project === project.value)
    )
      void load()
  }
  useServerEvents(onEvent, () => void load())
  onBeforeUnmount(() => {
    stopped = true
  })

  return { mcp, skills }
}
