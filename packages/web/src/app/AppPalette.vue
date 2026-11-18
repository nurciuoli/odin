<script setup lang="ts">
// The command palette (⌘K), mounted once in the shell. One box for everything: type to search sessions, projects,
// files and commands together (fuzzy, grouped, a few of each), or narrow it with a sigil: `>` commands, `#` projects,
// `/` files. With nothing typed it shows what needs you, what you opened lately and a few commands. Whatever you
// type can also start a new session: the last row is always "Start a session with …". Choosing a session, project or
// file opens it; closing without a choice puts focus back where it was.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { HarnessInfo, ProjectMapFile, Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuCommandPalette, type CommandItem, type CommandSource } from '@/components/CommandPalette'
import { harnessLabel, relativeTime, SESSION_DISPLAY } from '@/screens/shared/format'
import { useCommands } from './commands'
import { useDrafts } from './drafts'
import { fuzzyFilter } from './fuzzy'
import { loadRecents, pushRecent, type RecentEntry } from './paletteRecents'
import { useProjects } from './projects'
import { sidebarOrder, useSessions } from './sessions'
import { keyLabel } from './shortcuts'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ quickLaunch: [opts?: { harness?: string }]; nextWaiting: [] }>()

const api = useApi()
const route = useRoute()
const router = useRouter()
const projects = useProjects()
const live = useSessions()
const commands = useCommands()
const drafts = useDrafts()

// How many of each kind the mixed view lists; a sigil lifts the cap.
const MIXED_LIMIT = { session: 3, project: 2, file: 4, command: 3 }
const FILE_PROJECTS = 3

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

const GROUPS: Partial<Record<Session['state'], string>> = { waiting: 'Waiting', running: 'Running' }
function sessionItem(s: Session, group?: string): CommandItem {
  return {
    id: `session:${s.id}`,
    label: s.title,
    detail: projectsOf(s).join(', '),
    icon: s.state === 'waiting' ? 'bell' : s.state === 'running' ? 'play' : 'message',
    hint: `${SESSION_DISPLAY[s.state].label} · ${relativeTime(s.updatedAt)}`,
    group: group ?? GROUPS[s.state] ?? 'Recent',
  }
}
function sessionResults(term: string): CommandItem[] {
  return fuzzyFilter(sessions.value, term, s => s.title).map(({ item, match }) => ({
    ...sessionItem(item, 'Sessions'),
    matches: match.indices,
  }))
}
function sessionResultsByProject(term: string): CommandItem[] {
  // a query that names the project finds its sessions too, without highlighting the title
  const seen = new Set(sessionResults(term).map(i => i.id))
  return fuzzyFilter(sessions.value, term, s => `${s.title} ${projectsOf(s).join(' ')}`)
    .map(({ item }) => sessionItem(item, 'Sessions'))
    .filter(i => !seen.has(i.id))
}

// ── projects ──
function projectItem(p: { name: string; title: string }, group = 'Projects'): CommandItem {
  return { id: `project:${p.name}`, label: p.title, icon: 'folder', hint: p.name, group }
}

// ── files: the file maps of the project you're in and the most recently active others, fetched when the palette opens ──
const currentProject = ref<string | undefined>(undefined)
const fileMaps = ref<Record<string, ProjectMapFile[]>>({})
const requested = new Set<string>()
async function loadFiles() {
  const here = currentProject.value
  const names = [
    ...(here ? [here] : []),
    ...[...projects.projects.value]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(p => p.name)
      .filter(n => n !== here),
  ].slice(0, FILE_PROJECTS)
  await Promise.all(
    names
      .filter(n => !requested.has(n))
      .map(async name => {
        requested.add(name)
        try {
          const map = await api.getProjectFileMap(name)
          fileMaps.value = { ...fileMaps.value, [name]: map.files }
        } catch {
          requested.delete(name)
        }
      }),
  )
}
const allFiles = computed(() =>
  Object.entries(fileMaps.value).flatMap(([project, files]) =>
    files.map(f => ({ project, path: f.path })),
  ),
)
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
function fileItem(f: { project: string; path: string }, indices: number[] = []): CommandItem {
  const base = baseName(f.path)
  const offset = f.path.length - base.length
  return {
    id: `file:${f.project}:${f.path}`,
    label: base,
    detail: dirName(f.path),
    icon: 'file',
    hint: projectTitle(f.project),
    group: 'Files',
    matches: indices.filter(i => i >= offset).map(i => i - offset),
  }
}
function fileResults(term: string): CommandItem[] {
  const here = currentProject.value
  // the file's name is what you type: fuzzy over that; failing it, the typed text as a plain piece of the path
  const byName = fuzzyFilter(allFiles.value, term, f => baseName(f.path)).map(
    ({ item, match }) => ({
      item,
      score: match.score,
      indices: match.indices.map(i => i + item.path.length - baseName(item.path).length),
    }),
  )
  const named = new Set(byName.map(r => r.item))
  const needle = term.trim().toLowerCase()
  const byPath = needle
    ? allFiles.value
        .filter(f => !named.has(f) && f.path.toLowerCase().includes(needle))
        .map(item => ({ item, score: -50, indices: [] as number[] }))
    : allFiles.value.map(item => ({ item, score: 0, indices: [] as number[] }))
  // files from the project you're in come first among equals
  return [...byName, ...byPath]
    .map((r, order) => ({ r, order, rank: r.score + (r.item.project === here ? 2 : 0) }))
    .sort((a, b) => b.rank - a.rank || a.order - b.order)
    .map(({ r }) => fileItem(r.item, r.indices))
}

// ── commands ──
const onSession = computed(() => route.name === 'session')
const harnesses = ref<HarnessInfo[]>([])
async function loadHarnesses() {
  if (harnesses.value.length) return
  try {
    harnesses.value = (await api.getSettings()).harnesses.filter(h => h.available)
  } catch {
    // the harness commands just don't appear
  }
}
watch(open, v => {
  if (!v) return
  currentProject.value = undefined
  void resolveCurrentProject().then(() => loadFiles())
  void loadHarnesses()
})
async function resolveCurrentProject() {
  if (typeof route.params.name === 'string' && route.path.startsWith('/p/'))
    currentProject.value = route.params.name
  else if (route.name === 'session' && typeof route.params.id === 'string') {
    const id = route.params.id
    const known = [...live.active.value, ...live.sidebar.value, ...(loaded.value ?? [])].find(
      s => s.id === id,
    )
    currentProject.value = known?.project
  }
}

type RunItem = CommandItem & { run: () => void }
const go = (to: Parameters<typeof router.push>[0]) => () => void router.push(to)
const appCommands = computed<RunItem[]>(() => [
  {
    id: 'action:new',
    label: 'New session',
    icon: 'plus',
    hint: keyLabel('Mod+Shift+O'),
    run: () => emit('quickLaunch'),
  },
  {
    id: 'action:waiting',
    label: 'Next waiting session',
    icon: 'bell',
    hint: keyLabel('Mod+J'),
    disabledReason: live.waiting.value.some(s => s.id !== route.params.id)
      ? undefined
      : 'Nothing waiting',
    run: () => emit('nextWaiting'),
  },
  ...harnesses.value.map(h => ({
    id: `action:new-on:${h.id}`,
    label: `New session on ${harnessLabel(h.id)}`,
    icon: 'plus' as const,
    run: () => emit('quickLaunch', { harness: h.id }),
  })),
  ...(onSession.value
    ? [
        {
          id: 'action:handoff',
          label: 'Hand off to another harness…',
          icon: 'gitBranch' as const,
          disabledReason: 'Coming soon',
          run: () => {},
        },
      ]
    : []),
  { id: 'action:home', label: 'Go home', icon: 'board', run: go({ name: 'home' }) },
  { id: 'action:history', label: 'All sessions', icon: 'clock', run: go({ name: 'history' }) },
  { id: 'action:library', label: 'Open Library', icon: 'sparkle', run: go({ name: 'library' }) },
  {
    label: 'Compare sessions',
    icon: 'gitPullRequest',
    run: go({ name: 'compare' }),
  },
  { id: 'action:settings', label: 'Open Settings', icon: 'gear', run: go({ name: 'settings' }) },
  ...commands.value.map(c => ({
    id: `command:${c.id}`,
    label: c.label,
    icon: c.icon,
    hint: c.hint,
    disabledReason: c.disabledReason,
    run: c.run,
  })),
])
function commandResults(term: string): CommandItem[] {
  const rows = term.trim()
    ? fuzzyFilter(appCommands.value, term, c => c.label).map(({ item, match }) => ({
        item,
        indices: match.indices,
      }))
    : appCommands.value.map(item => ({ item, indices: [] as number[] }))
  return rows.map(({ item: { run: _run, ...item }, indices }) => ({
    ...item,
    group: 'Commands',
    matches: indices,
  }))
}

// ── start a session from what you typed ──
function startItem(term: string): CommandItem[] {
  const text = term.trim()
  if (!text) return []
  const short = text.length > 48 ? `${text.slice(0, 47)}…` : text
  return [
    {
      id: `new:${text}`,
      label: `Start a session: “${short}”`,
      icon: 'plus',
      hint: 'New session',
      group: 'Start',
      matches: [],
    },
  ]
}

const limited = (items: CommandItem[], scoped: boolean, n: number) =>
  scoped ? items : items.slice(0, n)

const sources = computed<CommandSource[]>(() => [
  {
    id: 'sessions',
    label: 'Sessions',
    resolve: (term, { scoped }) =>
      limited(
        [...sessionResults(term), ...sessionResultsByProject(term)],
        scoped,
        MIXED_LIMIT.session,
      ),
  },
  {
    id: 'projects',
    prefix: '#',
    label: 'Projects',
    resolve: (term, { scoped }) =>
      limited(
        fuzzyFilter(projects.projects.value, term, p => `${p.title} ${p.name}`).map(
          ({ item, match }) => ({
            ...projectItem(item),
            matches: match.indices.filter(i => i < item.title.length),
          }),
        ),
        scoped,
        MIXED_LIMIT.project,
      ),
  },
  {
    id: 'files',
    prefix: '/',
    label: 'Files',
    resolve: (term, { scoped }) =>
      !term.trim() && !scoped ? [] : limited(fileResults(term), scoped, MIXED_LIMIT.file),
  },
  {
    id: 'commands',
    prefix: '>',
    label: 'Commands',
    resolve: (term, { scoped }) => limited(commandResults(term), scoped, MIXED_LIMIT.command),
  },
  {
    id: 'start',
    label: 'Start',
    resolve: (term, { scoped }) => (scoped ? [] : startItem(term)),
  },
])

// The empty query: what needs you, what you opened lately, a few commands.
const recents = ref<RecentEntry[]>(loadRecents())
watch(open, v => {
  if (v) recents.value = loadRecents()
})
const SUGGESTED = [
  'action:new',
  'action:library',
  'command:session-toggle-files',
  'action:settings',
]
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
  const attention = sessions.value.filter(s => s.state === 'waiting' || s.state === 'running')
  const seen = new Set(attention.map(s => `session:${s.id}`))
  const lately: CommandItem[] = recents.value
    .filter(e => !seen.has(e.id))
    .map(e => ({ ...e, group: 'Recent' }))
  // before anything has been opened from the palette, the latest sessions stand in
  const fill = lately.length
    ? lately
    : sessions.value
        .filter(s => !seen.has(`session:${s.id}`))
        .slice(0, 4)
        .map(s => sessionItem(s, 'Recent'))
  const suggested = SUGGESTED.flatMap(id => {
    const c = commandResults('').find(i => i.id === id)
    return c ? [{ ...c, matches: undefined, group: 'Commands' }] : []
  })
  const list = [
    ...attention.slice(0, 4).map(s => sessionItem(s)),
    ...fill.slice(0, 5),
    ...suggested,
  ]
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

function remember(item: CommandItem) {
  const { id, label, icon, detail, hint } = item
  recents.value = pushRecent({ id, label, icon, detail, hint })
}

function onSelect(item: CommandItem, opts: { newTab: boolean }) {
  chose = true
  const [kind, ...rest] = item.id.split(':')
  const value = rest.join(':')
  if (kind === 'session') {
    remember(item)
    const to = { name: 'session', params: { id: value } }
    if (opts.newTab) window.open(router.resolve(to).href, '_blank', 'noopener')
    else void router.push(to)
  } else if (kind === 'project') {
    remember(item)
    void router.push({ name: 'project-overview', params: { name: value } })
  } else if (kind === 'file') {
    remember(item)
    const at = value.indexOf(':')
    const to = {
      name: 'project-files',
      params: { name: value.slice(0, at) },
      query: { file: value.slice(at + 1) },
    }
    if (opts.newTab) window.open(router.resolve(to).href, '_blank', 'noopener')
    else void router.push(to)
  } else if (kind === 'new') {
    drafts.set('new', { text: value, attachments: [] })
    void nextTick(() => emit('quickLaunch'))
  } else {
    // commands may open a dialog of their own: let the palette's close (and its focus restore) finish first
    const command = appCommands.value.find(a => a.id === item.id)
    if (command) void nextTick(() => command.run())
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
        Nothing matches “{{ term }}”. Type <kbd>&gt;</kbd> for commands, <kbd>#</kbd> for projects
        or <kbd>/</kbd> for files.
      </p>
    </template>
    <template #footer>
      <span class="iu-cmdk__hint"><kbd>↑↓</kbd>navigate</span>
      <span class="iu-cmdk__hint"><kbd>↵</kbd>open</span>
      <span class="iu-cmdk__hint"
        ><kbd>{{ keyLabel('Mod+Enter') }}</kbd
        >new tab</span
      >
      <span class="app-palette__spacer" />
      <span class="iu-cmdk__hint"><kbd>&gt;</kbd>commands</span>
      <span class="iu-cmdk__hint"><kbd>#</kbd>projects</span>
      <span class="iu-cmdk__hint"><kbd>/</kbd>files</span>
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
.app-palette__spacer {
  flex: 1;
}
</style>
