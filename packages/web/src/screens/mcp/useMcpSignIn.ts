// Open a remote MCP server's sign-in page and watch until Odin has the token.
import { onBeforeUnmount, ref } from 'vue'
import type { McpOAuthStatus } from '@odin/shared/api'
import { useApi } from '@/api'
import { useToast } from '@/components/Toast'

const POLL_MS = 2000
const GIVE_UP_MS = 3 * 60_000

export function useMcpSignIn() {
  const api = useApi()
  const { toast } = useToast()
  const status = ref<Record<string, McpOAuthStatus | 'unknown'>>({})
  const signingIn = ref<{ id: string; name: string; url: string } | null>(null)
  let poll: ReturnType<typeof setInterval> | null = null

  function stop() {
    if (poll) clearInterval(poll)
    poll = null
  }
  onBeforeUnmount(stop)

  async function load(ids: string[]) {
    await Promise.all(
      ids.map(async id => {
        let next: McpOAuthStatus | 'unknown'
        try {
          next = await api.getMcpOAuth(id)
        } catch {
          next = 'unknown'
        }
        status.value = { ...status.value, [id]: next }
      }),
    )
  }

  async function connect(id: string, name: string) {
    stop()
    try {
      const { authorizationUrl } = await api.startMcpOAuth(id, window.location.origin)
      signingIn.value = { id, name, url: authorizationUrl }
      window.open(authorizationUrl, '_blank', 'noopener')
      const until = Date.now() + GIVE_UP_MS
      poll = setInterval(async () => {
        await load([id])
        const s = status.value[id]
        if (typeof s === 'object' && s.state === 'connected') {
          stop()
          signingIn.value = null
          toast({ title: `${name} is signed in`, intent: 'success' })
        } else if (Date.now() > until) {
          stop()
          signingIn.value = null
        }
      }, POLL_MS)
    } catch (e) {
      signingIn.value = null
      toast({
        title: `Couldn't start sign-in for ${name}`,
        description: e instanceof Error ? e.message : String(e),
        intent: 'danger',
      })
    }
  }

  async function disconnect(id: string, name: string) {
    try {
      await api.disconnectMcpOAuth(id)
      await load([id])
      toast({ title: `${name} signed out`, intent: 'success' })
    } catch (e) {
      toast({
        title: `Couldn't sign out of ${name}`,
        description: e instanceof Error ? e.message : String(e),
        intent: 'danger',
      })
    }
  }

  return { status, signingIn, load, connect, disconnect }
}
