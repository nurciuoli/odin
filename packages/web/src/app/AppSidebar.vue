<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuHoverCard } from '@/components/HoverCard'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuDialog } from '@/components/Modal'
import { IuNavGroup, IuNavItem, IuSidebar } from '@/components/Sidebar'
import { IuFlock } from '@/components/Spinner'
import { IuSkeleton } from '@/components/States'
import { useApi, useIsMock } from '@/api'
import type { Session } from '@odin/shared/api'
import { SESSION_DISPLAY, needYouCount } from '@/screens/shared/format'
import { plural, projectStatus, relativeTime } from '@/screens/shared/format'
import { useSessionPerches } from '@/screens/shared/useSessionPerches'
import { layoutDemand, sidebarCrowded } from './layout'
import { openNewProject } from './newProject'
import { useProjects } from './projects'
import { useSessions } from './sessions'
import ProjectHoverCard from './hovercards/ProjectHoverCard.vue'
import SessionHoverCard from './hovercards/SessionHoverCard.vue'
import { isUnread } from './seen'

const route = useRoute()
const router = useRouter()
const api = useApi()
const store = useProjects()
const sessions = useSessions()
const mock = useIsMock()
// Waiting, then running (start order, so rows hold still), then the rest; side threads never appear. The store
// builds the list so the session shortcuts (⌥↑/⌥↓, ⌘1…9) step through exactly these rows.
const conversations = sessions.sidebar
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(clock))
const isLive = (s: Session) => s.state === 'running' || s.state === 'waiting'
const inProgress = computed(() => conversations.value.filter(s => isLive(s) || isUnread(s)))
const perches = useSessionPerches(computed(() => inProgress.value.filter(isLive)))
const sections = computed(() => [
  { label: 'In progress', active: true, sessions: inProgress.value },
  {
    label: 'Finished / read',
    active: false,
    sessions: conversations.value.filter(s => !inProgress.value.includes(s)),
  },
])
function activityOf(s: Session): string {
  if (!isLive(s)) return `${SESSION_DISPLAY[s.state].label}, not opened yet`
  const perch = perches.value[s.id]
  return [projectOf(s), perch?.activity === 'Starting' ? perch.word : perch?.activity]
    .filter(Boolean)
    .join(' · ')
}
function projectOf(s: Session): string {
  const names = s.projects?.length ? s.projects : [s.project]
  const first = store.projects.value.find(p => p.name === names[0])?.title ?? names[0]
  return first + (names.length > 1 ? ` +${names.length - 1}` : '')
}
const flockOf = (s: Session) =>
  isLive(s) ? perches.value[s.id]?.flock : s.state === 'failed' ? 'failed' : 'idle'
const recentPhase = sessions.recentPhase
const sessionActions: MenuItem[] = [
  { id: 'rename', label: 'Rename…', icon: 'pencil' },
  { id: 'delete', label: 'Delete…', icon: 'trash', destructive: true },
]
const selected = ref<Session | null>(null)
const action = ref('')
const actionOpen = ref(false)
const draftTitle = ref('')
const saving = ref(false)
const actionError = ref('')
function openAction(session: Session, id: string) {
  selected.value = session
  action.value = id
  draftTitle.value = session.title
  actionError.value = ''
  actionOpen.value = true
}
async function saveAction() {
  const session = selected.value
  if (!session || saving.value || (action.value === 'rename' && !draftTitle.value.trim())) return
  saving.value = true
  actionError.value = ''
  try {
    if (action.value === 'rename')
      await api.updateSession(session.id, { title: draftTitle.value.trim() })
    else {
      await api.deleteSession(session.id)
      if (route.name === 'session' && route.params.id === session.id) await router.push('/')
    }
    actionOpen.value = false
    await Promise.all([sessions.reload(), sessions.reloadRecent()])
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error)
  } finally {
    saving.value = false
  }
}

// The collapsed rail has no room for the rows' labels, so the Sessions icon carries how many wait for you.
const waitingLabel = computed(() => {
  const n = sessions.waiting.value.length
  return n > 0 ? needYouCount(n) : ''
})

// Live counts from the sessions store; the project summary's own counts lag until the next refetch.
const rows = computed(() =>
  store.projects.value.map(p => {
    const live = sessions.countsFor(p.name)
    return { ...p, sessions: { ...p.sessions, ...live } }
  }),
)

// The sidebar folds to its icon rail when the window is narrow, or when the open screen needs the room (a docked
// preview pane beside the conversation). Folding that way is not a choice, so it is not remembered: the rail opens
// again when there is room, and desktop otherwise keeps the user's last choice.
const NARROW = '(max-width: 860px)'
const COLLAPSED_KEY = 'odin.sidebar.collapsed'
const collapsed = ref(false)
const narrow = ref(false)
const viewport = ref(typeof window === 'undefined' ? 1600 : window.innerWidth)
const crowded = computed(() => sidebarCrowded(viewport.value, layoutDemand.value))
const folded = computed(() => narrow.value || crowded.value)
let query: MediaQueryList | null = null
const readDesktopChoice = () => {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}
const saveDesktopChoice = (value: boolean) => {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, String(value))
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}
const toggleCollapsed = () => {
  collapsed.value = !collapsed.value
  if (!narrow.value) saveDesktopChoice(collapsed.value)
}
const onQuery = (e: MediaQueryListEvent) => (narrow.value = e.matches)
const onResize = () => (viewport.value = window.innerWidth)
watch(folded, f => (collapsed.value = f ? true : readDesktopChoice()))
onMounted(() => {
  viewport.value = window.innerWidth
  window.addEventListener('resize', onResize)
  query = typeof window.matchMedia === 'function' ? window.matchMedia(NARROW) : null
  narrow.value = query?.matches ?? false
  collapsed.value = folded.value ? true : readDesktopChoice()
  query?.addEventListener('change', onQuery)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  query?.removeEventListener('change', onQuery)
})
</script>

<template>
  <IuSidebar id="primary-navigation" v-model:collapsed="collapsed" :width="288">
    <template #workspace>
      <!-- The rail's top cell: the same 48px band as the column headers beside it. -->
      <div class="app-wordmark" :class="{ 'is-collapsed': collapsed }">
        <RouterLink v-if="!collapsed" to="/" class="app-wordmark__link" aria-label="Odin, home">
          <img class="app-wordmark__mark" src="/odin.svg" alt="" width="28" height="28" />
          <span v-if="!collapsed" class="app-wordmark__text">odin</span>
        </RouterLink>
        <IuBadge
          v-if="mock && !collapsed"
          intent="info"
          variant="tag"
          size="xs"
          title="Running on built-in sample data, not your projects"
        >
          Sample data
        </IuBadge>
        <IuButton
          class="app-sidebar-toggle"
          variant="ghost"
          size="sm"
          icon-only
          :aria-label="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          :title="collapsed ? 'Expand sidebar' : 'Collapse sidebar'"
          :aria-expanded="!collapsed"
          aria-controls="primary-navigation"
          @click="toggleCollapsed"
        >
          <template #icon>
            <IuIcon :name="collapsed ? 'panelRightOpen' : 'panelRight'" :size="16" />
          </template>
        </IuButton>
      </div>
    </template>

    <IuNavItem label="Home" icon="board" to="/" :active="route.name === 'home'" />
    <IuNavItem
      label="Library"
      icon="addLayer"
      to="/library"
      :active="route.name === 'library' || route.name === 'library-asset'"
    />
    <IuNavItem label="Projects" icon="folder" to="/projects" :active="route.name === 'projects'" />
    <div class="app-nav-slot">
      <IuNavItem
        label="Sessions"
        icon="clock"
        to="/sessions"
        :active="route.name === 'history'"
        :aria-label="waitingLabel ? `Sessions, ${waitingLabel}` : undefined"
      />
      <span v-if="collapsed && waitingLabel" class="app-nav-slot__count" aria-hidden="true">{{
        sessions.waiting.value.length
      }}</span>
    </div>
    <IuNavItem label="New chat" icon="plus" to="/?launch=1" />

    <IuNavGroup label="Projects">
      <template #actions>
        <IuButton
          variant="ghost"
          size="sm"
          icon-only
          aria-label="New project"
          title="New project"
          @click="openNewProject()"
        >
          <template #icon><IuIcon name="plus" :size="14" /></template>
        </IuButton>
      </template>
      <IuSkeleton v-if="store.loading.value" shape="row" :rows="2" />
      <IuNavItem
        v-else-if="store.error.value"
        label="Couldn't load projects. Retry"
        icon="retry"
        @click="store.reload()"
      />
      <template v-else>
        <IuHoverCard v-for="p in rows" :key="p.name" :label="`${p.title} overview`">
          <IuNavItem
            :label="p.title"
            :status="projectStatus(p)"
            :to="{ name: 'project-overview', params: { name: p.name } }"
            :count="p.sessions.waiting + p.sessions.running || undefined"
            :active="route.params.name === p.name"
            :aria-label="
              [
                p.title,
                p.sessions.waiting > 0 ? needYouCount(p.sessions.waiting) : '',
                p.sessions.running > 0 ? `${plural(p.sessions.running, 'session')} running` : '',
                p.sync.state === 'error' || p.missing ? 'needs attention' : '',
              ]
                .filter(Boolean)
                .join(', ')
            "
          />
          <template #card><ProjectHoverCard :name="p.name" /></template>
        </IuHoverCard>
        <p v-if="!store.projects.value.length" class="app-sidebar-note">No projects yet</p>
      </template>
    </IuNavGroup>

    <IuNavGroup label="Sessions">
      <IuSkeleton v-if="recentPhase === 'loading'" shape="row" :rows="2" />
      <IuNavItem
        v-else-if="recentPhase === 'error'"
        label="Couldn't load sessions. Retry"
        icon="retry"
        @click="sessions.reloadRecent()"
      />
      <section v-for="section in sections" :key="section.label" :aria-label="section.label">
        <div v-if="!collapsed" class="app-session-section">
          <span>{{ section.label }}</span>
          <span>{{ section.sessions.length }}</span>
        </div>
        <p v-if="!collapsed && !section.sessions.length" class="app-sidebar-note">
          {{ section.active ? 'No sessions in progress' : 'No finished sessions' }}
        </p>
        <IuHoverCard v-for="s in section.sessions" :key="s.id" :label="`${s.title} overview`">
          <IuMenu
            class="app-nav-slot"
            :class="{
              'is-collapsed': collapsed,
            }"
            :items="sessionActions"
            context-menu
            @select="openAction(s, $event)"
          >
            <template #trigger="{ open }">
              <IuNavItem
                class="app-nav-slot__item"
                :label="s.title"
                :description="section.active && !collapsed ? projectOf(s) : undefined"
                :status="!section.active && collapsed ? SESSION_DISPLAY[s.state].status : undefined"
                :to="{ name: 'session', params: { id: s.id } }"
                :active="route.params.id === s.id"
                aria-haspopup="menu"
                :aria-expanded="open"
                :aria-label="`${s.title}${section.active ? `, ${activityOf(s)}${isLive(s) ? `, ${perches[s.id]?.word}` : ''}` : ''}, ${SESSION_DISPLAY[s.state].label}`"
              >
                <template v-if="section.active && collapsed" #leading>
                  <IuFlock
                    :state="flockOf(s)"
                    :agents="perches[s.id]?.agents"
                    :size="collapsed ? 'sm' : 'md'"
                    tone="neutral"
                  />
                </template>
                <template v-if="section.active && !collapsed" #content>
                  <span class="app-session-row">
                    <span class="app-session-row__title">{{ s.title }}</span>
                    <time
                      class="app-session-row__time"
                      :datetime="s.updatedAt"
                      :title="s.updatedAt"
                      >{{ relativeTime(s.updatedAt, now) }}</time
                    >
                    <span class="app-session-row__project">{{ projectOf(s) }}</span>
                    <IuFlock
                      class="app-session-row__flock"
                      :state="flockOf(s)"
                      :agents="perches[s.id]?.agents"
                      size="sm"
                      tone="neutral"
                    />
                  </span>
                </template>
              </IuNavItem>
            </template>
          </IuMenu>
          <template #card><SessionHoverCard :session="s" /></template>
        </IuHoverCard>
      </section>
    </IuNavGroup>

    <template #footer>
      <IuNavItem
        label="Settings"
        icon="sliders"
        to="/settings"
        :active="route.name === 'settings'"
      />
    </template>
  </IuSidebar>
  <IuDialog v-model:open="actionOpen" size="sm" :dismissible="!saving">
    <template #header
      ><h2 class="app-session-action__title">
        {{ action === 'rename' ? 'Rename session' : `Delete “${selected?.title}”?` }}
      </h2></template
    >
    <form v-if="action === 'rename'" id="sidebar-rename" @submit.prevent="saveAction">
      <IuField v-model="draftTitle" label="Session title" :disabled="saving" />
    </form>
    <p v-else class="app-session-action__body">
      This removes the session and its transcript. Its branch and worktree are kept.
    </p>
    <IuCallout v-if="actionError" intent="danger" variant="inline" live>{{
      actionError
    }}</IuCallout>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="saving" @click="actionOpen = false"
        >Cancel</IuButton
      >
      <IuButton
        :variant="action === 'rename' ? 'primary' : 'danger'"
        size="sm"
        :loading="saving"
        :disabled="action === 'rename' && !draftTitle.trim()"
        @click="saveAction"
        >{{ action === 'rename' ? 'Save' : 'Delete' }}</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.app-wordmark {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  height: 48px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.app-wordmark.is-collapsed {
  justify-content: center;
  padding: 0;
}
.app-wordmark__link {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  color: var(--iu-text);
  border-radius: var(--iu-radius-md);
}
.app-sidebar-toggle {
  flex: none;
}
.app-wordmark__link:hover {
  color: var(--iu-text);
}
.app-wordmark__link:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.app-wordmark__mark {
  flex: none;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--iu-radius-md);
  background: var(--iu-text);
}
.app-wordmark__text {
  font-family: var(--iu-font-brand);
  font-size: var(--iu-font-size-24);
  font-weight: var(--iu-font-weight-semibold);
}
.app-sidebar-note {
  margin: 0;
  padding: 4px 10px 4px 26px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}

.app-session-section {
  display: flex;
  justify-content: space-between;
  padding: 16px 10px 6px 26px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
}
.app-session-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
  row-gap: 3px;
}
.app-session-row__title,
.app-session-row__project {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.app-session-row__time,
.app-session-row__project {
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-regular);
}
.app-session-row__flock {
  justify-self: end;
}
/* Session context-menu wrapper; waiting count overlays the collapsed Sessions icon. */
.app-nav-slot {
  position: relative;
}
.app-nav-slot:has(.app-nav-slot__item) {
  display: block;
  min-width: 0;
}
.app-session-action__title {
  margin: 0;
  font-size: var(--iu-font-size-16);
  font-weight: var(--iu-font-weight-semibold);
}
.app-session-action__body {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-13);
}
/* Perched on the icon's top-right corner. The link's name carries the same count in words. */
.app-nav-slot__count {
  position: absolute;
  top: -3px;
  right: -3px;
  box-sizing: border-box;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: var(--iu-warning);
  color: var(--iu-accent-ink);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  font-weight: var(--iu-font-weight-semibold);
  pointer-events: none;
}
</style>
