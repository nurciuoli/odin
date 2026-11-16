// The shell's own shortcuts: palette, quick launch, cheat sheet and moving between sessions. Registered while the
// shell is mounted; screens add theirs (⌥/ in a session) with `registerShortcut` directly.
import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast } from '@/components/Toast'
import type { SessionsStore } from './sessions'
import { installShortcuts, nextWaiting, registerShortcut, stepSession } from './shortcuts'

export interface ShellDialogs {
  palette: Ref<boolean>
  quickLaunch: Ref<boolean>
  help: Ref<boolean>
}

export function useAppShortcuts(dialogs: ShellDialogs, sessions: SessionsStore) {
  const route = useRoute()
  const router = useRouter()
  const { toast } = useToast()
  const currentId = () =>
    route.name === 'session' && typeof route.params.id === 'string' ? route.params.id : null
  const open = (id: string | null | undefined) => {
    if (id && id !== currentId()) void router.push({ name: 'session', params: { id } })
  }

  function goNextWaiting() {
    const next = nextWaiting(
      sessions.waiting.value.map(s => s.id),
      currentId(),
    )
    if (next) open(next)
    else toast({ title: 'Nothing else is waiting for you', intent: 'info', duration: 2500 })
  }

  const closeDialogs = () => {
    dialogs.quickLaunch.value = false
    dialogs.help.value = false
  }

  let stop: (() => void) | null = null
  const unregister: (() => void)[] = []
  onMounted(() => {
    stop = installShortcuts()
    unregister.push(
      registerShortcut({
        id: 'palette',
        keys: 'Mod+K',
        label: 'Search sessions, actions and projects',
        group: 'General',
        whileTyping: true,
        inDialog: true,
        run: () => {
          const next = !dialogs.palette.value
          if (next) closeDialogs()
          dialogs.palette.value = next
        },
      }),
      registerShortcut({
        id: 'quick-launch',
        keys: 'Mod+Shift+O',
        label: 'New session (starts in the background)',
        group: 'General',
        whileTyping: true,
        run: () => (dialogs.quickLaunch.value = true),
      }),
      registerShortcut({
        id: 'help',
        keys: '?',
        label: 'Show keyboard shortcuts',
        group: 'General',
        run: () => (dialogs.help.value = true),
      }),
      registerShortcut({
        id: 'session-prev',
        keys: 'Alt+ArrowUp',
        label: 'Previous session in the sidebar',
        group: 'Sessions',
        whileTyping: true,
        run: () =>
          open(
            stepSession(
              sessions.sidebar.value.map(s => s.id),
              currentId(),
              -1,
            ),
          ),
      }),
      registerShortcut({
        id: 'session-next',
        keys: 'Alt+ArrowDown',
        label: 'Next session in the sidebar',
        group: 'Sessions',
        whileTyping: true,
        run: () =>
          open(
            stepSession(
              sessions.sidebar.value.map(s => s.id),
              currentId(),
              1,
            ),
          ),
      }),
      registerShortcut({
        id: 'session-waiting',
        keys: 'Mod+J',
        label: 'Next session waiting for you',
        group: 'Sessions',
        whileTyping: true,
        run: goNextWaiting,
      }),
      registerShortcut({
        id: 'session-nth',
        keys: 'Mod+1-9',
        label: 'Open the first to ninth session in the sidebar',
        group: 'Sessions',
        run: e => {
          const n = Number(/\d/.exec(e.code)?.[0] ?? e.key)
          open(sessions.sidebar.value[n - 1]?.id)
        },
      }),
    )
  })
  onBeforeUnmount(() => {
    stop?.()
    for (const off of unregister.splice(0)) off()
  })

  return { goNextWaiting }
}
