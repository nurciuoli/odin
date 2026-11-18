<script setup lang="ts">
// The command palette (⌘K), mounted once in the shell. Sessions by default (waiting, then running, then recent),
// `>` for actions (app-wide ones plus whatever the current screen registered), `#` for projects. Choosing a session
// opens it; closing without a choice puts focus back where it was.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuCommandPalette, type CommandItem, type CommandSource } from '@/components/CommandPalette'
import { relativeTime, SESSION_DISPLAY } from '@/screens/shared/format'
import { useCommands } from './commands'
import { useProjects } from './projects'
import { sidebarOrder, useSessions } from './sessions'
import { keyLabel } from './shortcuts'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ quickLaunch: []; nextWaiting: [] }>()

const api = useApi()
const route = useRoute()
const router = useRouter()
const projects = useProjects()
const live = useSessions()
const commands = useCommands()

// ── sessions ──
const loaded = ref<Session[] | null>(null)
const loadError = ref(false)
let request = 0
async function load() {
  const mine = ++request
  try {
    const list = await api.listSessions({ archived: false, limit: 50 })
    if (mine !== request) return
    loaded.value = list.filter(s => !s.aside)
    loadError.value = false
  } catch {
    if (mine === request) loadError.value = true
  }
}
// Fetched the first time the palette opens, then kept current from the sessions store's revision.
let refresh: ReturnType<typeof setTimeout> | undefined
watch(open, v => {
  if (v && !loaded.value) void load()
})
watch(live.revision, () => {
  if (!loaded.value) return
  clearTimeout(refresh)
  refresh = setTimeout(() => void load(), 250)
})
onBeforeUnmount(() => clearTimeout(refresh))

const sessions = computed(() => {
  const byId = new Map((loaded.value ?? []).map(s => [s.id, s]))
  for (const s of live.active.value) byId.set(s.id, s)
  return sidebarOrder([...byId.values()])
})
const projectTitle = (name: string) =>
  projects.projects.value.find(p => p.name === name)?.title ?? name
const projectsOf = (s: Session) => (s.projects ?? [s.project]).map(projectTitle)

const GROUPS: Partial<Record<Session['state'], string>> = {
  waiting: SESSION_DISPLAY.waiting.label,
  running: SESSION_DISPLAY.running.label,
}
function sessionItem(s: Session): CommandItem {
  return {
    id: `session:${s.id}`,
    label: s.title,
    icon: SESSION_DISPLAY[s.state].icon,
    hint: `${SESSION_DISPLAY[s.state].label} · ${relativeTime(s.updatedAt)}`,
    group: GROUPS[s.state] ?? 'Recent',
  }
}
/** Every word of the query appears in the title or a project title. */
function matches(s: Session, term: string) {
  const hay = [s.title, ...projectsOf(s)].join(' ').toLowerCase()
  return term
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(w => hay.includes(w))
}

// ── actions ──
const onSession = computed(() => route.name === 'session')
const appActions = computed<(CommandItem & { run: () => void })[]>(() => [
  {
    id: 'action:new',
    label: 'New session',
    icon: 'plus',
    hint: keyLabel('Mod+Shift+O'),
    group: 'Actions',
    run: () => emit('quickLaunch'),
  },
  {
    id: 'action:waiting',
    label: 'Next waiting session',
    icon: 'bell',
    hint: keyLabel('Mod+J'),
    group: 'Actions',
    disabledReason: live.waiting.value.some(s => s.id !== route.params.id)
      ? undefined
      : 'Nothing waiting',
    run: () => emit('nextWaiting'),
  },
  {
    id: 'action:home',
    label: 'Go home',
    icon: 'board',
    group: 'Actions',
    run: () => void router.push({ name: 'home' }),
  },
  {
    id: 'action:history',
    label: 'All sessions',
    icon: 'clock',
    group: 'Actions',
    run: () => void router.push({ name: 'history' }),
  },
  ...commands.value.map(c => ({
    id: `command:${c.id}`,
    label: c.label,
    icon: c.icon,
    hint: c.hint,
    disabledReason: c.disabledReason,
    group: onSession.value ? 'This session' : 'This page',
    run: c.run,
  })),
])

const sources = computed<CommandSource[]>(() => [
  {
    id: 'sessions',
    label: 'Sessions',
    resolve: term => sessions.value.filter(s => matches(s, term)).map(sessionItem),
  },
  {
    id: 'actions',
    prefix: '>',
    label: 'Actions',
    resolve: term =>
      appActions.value
        .filter(a => a.label.toLowerCase().includes(term.trim().toLowerCase()))
        .map(({ run: _run, ...item }) => item),
  },
  {
    id: 'projects',
    prefix: '#',
    label: 'Projects',
    resolve: term =>
      projects.projects.value
        .filter(p => `${p.title} ${p.name}`.toLowerCase().includes(term.trim().toLowerCase()))
        .map(p => ({
          id: `project:${p.name}`,
          label: p.title,
          icon: 'folder' as const,
          hint: p.name,
          group: 'Projects',
        })),
  },
])

// The empty query: sessions in order, then a few actions to show what `>` holds.
const recent = computed<CommandItem[]>(() => {
  if (!loaded.value && loadError.value)
    return [
      {
        id: 'status:error',
        label: "Couldn't load sessions",
        group: 'Sessions',
        disabledReason: 'Close and reopen to retry',
      },
    ]
  if (!loaded.value && !live.active.value.length)
    return [
      { id: 'status:loading', label: 'Loading sessions…', group: 'Sessions', disabledReason: ' ' },
    ]
  const list = sessions.value.slice(0, 12).map(sessionItem)
  if (!list.length)
    return [
      { id: 'status:empty', label: 'No sessions yet', group: 'Sessions', disabledReason: ' ' },
    ]
  return list
})

// ── focus ──
let returnTo: HTMLElement | null = null
let chose = false
watch(open, v => {
  if (v) {
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    chose = false
  } else if (!chose && returnTo?.isConnected) {
    const el = returnTo
    void nextTick(() => el.focus({ preventScroll: true }))
  }
})

function onSelect(item: CommandItem, opts: { newTab: boolean }) {
  chose = true
  const [kind, ...rest] = item.id.split(':')
  const value = rest.join(':')
  if (kind === 'session') {
    const to = { name: 'session', params: { id: value } }
    if (opts.newTab) window.open(router.resolve(to).href, '_blank', 'noopener')
    else void router.push(to)
  } else if (kind === 'project') {
    void router.push({ name: 'project-overview', params: { name: value } })
  } else {
    // actions may open a dialog of their own: let the palette's close (and its focus restore) finish first
    const action = appActions.value.find(a => a.id === item.id)
    if (action) void nextTick(() => action.run())
  }
}
</script>

<template>
  <IuCommandPalette
    v-model:open="open"
    :sources="sources"
    :recent="recent"
    :hotkey="false"
    @select="onSelect"
  >
    <template #empty="{ term }">
      <p class="app-palette__empty">
        Nothing matches “{{ term }}”. Type <kbd>&gt;</kbd> for actions or <kbd>#</kbd> for projects.
      </p>
    </template>
  </IuCommandPalette>
</template>

<style>
.app-palette__empty {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.app-palette__empty kbd {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  padding: 0 5px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
}
</style>
