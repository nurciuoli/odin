<script setup lang="ts">
// A project's page: the compact header (title, branch, quick actions, Start chat) over a workbench that mirrors the
// session view the other way round. A side panel on the left holds the sections (with live counts) and the project's
// running sessions; the preview subpanel beside it shows the selected section and can go full screen.
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { ProjectDetail } from '@odin/shared/api'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { PROJECT_SECTIONS } from '@/app/router'
import { IuErrorState, IuSkeleton } from '@/components/States'
import { useSessions } from '@/app/sessions'
import { IuButton } from '@/components/Button'
import { IuIcon, type IconName } from '@/components/Icon'
import { IuStatusDot } from '@/components/StatusDot'
import { SESSION_DISPLAY } from '@/screens/shared/format'
import { useResource } from '@/screens/shared/useResource'
import ProjectHeader from './header/ProjectHeader.vue'
import { PROJECT_KEY } from './useProject'

const props = defineProps<{ name: string }>()
const api = useApi()
const route = useRoute()
const store = useProjects()

const res = useResource<ProjectDetail>(() => api.getProject(props.name))
// a saved form hands back the new record; a refetch fills in what changed elsewhere
const override = ref<ProjectDetail | null>(null)
const detail = computed(() => override.value ?? res.data.value)

watch(
  () => props.name,
  () => {
    override.value = null
    res.reset()
    void res.load()
  },
  { immediate: true },
)
// project.updated, a reconnect, and sync status all arrive through the shared store's revision/list
watch(
  () => store.revision(props.name),
  async () => {
    await res.load()
    override.value = null
  },
)

async function reload() {
  await res.load()
  override.value = null
}

provide(PROJECT_KEY, {
  detail: computed(() => detail.value!),
  setDetail: next => (override.value = next),
  reload,
})

// The sync badge follows `sync.status` events (the store patches them) faster than a refetch.
const sync = computed(
  () => store.projects.value.find(p => p.name === props.name)?.sync ?? detail.value?.sync,
)

const ICONS: Record<string, IconName> = {
  overview: 'board',
  sessions: 'message',
  files: 'folderTree',
  outputs: 'file',
  resources: 'sparkle',
  settings: 'gear',
}
const liveStore = useSessions()
const live = computed(() => liveStore.active.value.filter(s => s.project === props.name))
const badge = (id: string): string | null => {
  const d = detail.value
  if (id === 'sessions') return live.value.length ? String(live.value.length) : null
  if (id === 'files') return d?.dirtyFiles.length ? String(d.dirtyFiles.length) : null
  if (id === 'resources') return d?.agents.length ? String(d.agents.length) : null
  return null
}
const nav = computed(() =>
  PROJECT_SECTIONS.map(s => ({
    ...s,
    icon: ICONS[s.id] ?? 'file',
    badge: badge(s.id),
    to: { name: `project-${s.id}`, params: { name: props.name } },
  })),
)
const section = computed(() => (route.meta.section as string | undefined) ?? 'overview')
const sectionLabel = computed(() => PROJECT_SECTIONS.find(s => s.id === section.value)?.label)

// View state: the side panel collapses, the preview goes full screen (Esc leaves it). Both are per-viewer
// conveniences, so storage failures are ignored.
const SIDE_KEY = 'odin.project.side'
const sideOpen = ref(true)
try {
  sideOpen.value = localStorage.getItem(SIDE_KEY) !== 'closed'
} catch {
  /* private mode */
}
function toggleSide() {
  sideOpen.value = !sideOpen.value
  try {
    localStorage.setItem(SIDE_KEY, sideOpen.value ? 'open' : 'closed')
  } catch {
    /* private mode */
  }
}
const full = ref(false)
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && full.value) full.value = false
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="project">
    <IuSkeleton v-if="res.phase.value === 'loading' && !detail" shape="card" :rows="2" />
    <IuErrorState
      v-else-if="res.phase.value === 'error' && !detail"
      title="Couldn't load the project"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`project.load.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />
    <template v-else-if="detail">
      <ProjectHeader v-if="!full" :detail="detail" :sync="sync" />
      <div
        class="project__bench"
        :data-side="sideOpen ? 'open' : 'closed'"
        :data-full="full || undefined"
      >
        <aside v-show="sideOpen && !full" class="project__side" aria-label="Project">
          <nav aria-label="Project sections">
            <ul class="project__nav">
              <li v-for="n in nav" :key="n.id">
                <RouterLink
                  :to="n.to"
                  class="project__navitem"
                  :aria-current="section === n.id ? 'page' : undefined"
                >
                  <IuIcon :name="n.icon" :size="16" />
                  <span class="project__navlabel">{{ n.label }}</span>
                  <span v-if="n.badge" class="project__navbadge">{{ n.badge }}</span>
                </RouterLink>
              </li>
            </ul>
          </nav>
          <section v-if="live.length" class="project__live" aria-labelledby="project-live">
            <h2 id="project-live" class="project__sidehead">Running now</h2>
            <ul class="project__nav">
              <li v-for="s in live" :key="s.id">
                <RouterLink
                  :to="{ name: 'session', params: { id: s.id } }"
                  class="project__navitem"
                  :title="s.title"
                >
                  <IuStatusDot
                    :status="SESSION_DISPLAY[s.state].status"
                    :size="7"
                    :label="SESSION_DISPLAY[s.state].label"
                  />
                  <span class="project__navlabel">{{ s.title }}</span>
                </RouterLink>
              </li>
            </ul>
          </section>
        </aside>
        <section
          :id="`project-panel-${section}`"
          class="project__preview"
          :aria-label="sectionLabel"
        >
          <div class="project__bar">
            <IuButton
              v-if="!full"
              variant="ghost"
              size="sm"
              icon-only
              :aria-label="sideOpen ? 'Hide side panel' : 'Show side panel'"
              :title="sideOpen ? 'Hide side panel' : 'Show side panel'"
              :aria-expanded="sideOpen"
              @click="toggleSide"
            >
              <template #icon
                ><IuIcon :name="sideOpen ? 'panelRight' : 'panelRightOpen'" :size="16"
              /></template>
            </IuButton>
            <h2 class="project__title">{{ detail.title }} · {{ sectionLabel }}</h2>
            <span class="project__spacer" />
            <IuButton
              variant="ghost"
              size="sm"
              icon-only
              :aria-label="full ? 'Exit full screen' : 'Full screen'"
              :title="full ? 'Exit full screen (Esc)' : 'Full screen'"
              :aria-pressed="full"
              @click="full = !full"
            >
              <template #icon
                ><IuIcon :name="full ? 'minimize' : 'maximize'" :size="16"
              /></template>
            </IuButton>
          </div>
          <div class="project__body"><RouterView /></div>
        </section>
      </div>
    </template>
  </div>
</template>

<style>
.project {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.project__bench {
  display: grid;
  grid-template-columns: 172px minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.project__bench[data-side='closed'],
.project__bench[data-full] {
  grid-template-columns: minmax(0, 1fr);
}
.project__side {
  position: sticky;
  top: 8px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}
.project__nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.project__navitem {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 6px 8px;
  border-radius: var(--iu-radius-md);
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
  text-decoration: none;
}
.project__navitem:hover {
  background: var(--iu-hover);
  color: var(--iu-text-bright);
}
.project__navitem[aria-current='page'] {
  background: var(--iu-surface-raised);
  color: var(--iu-text-bright);
  font-weight: var(--iu-font-weight-medium);
}
.project__navitem:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.project__navlabel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project__navbadge {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.project__sidehead {
  margin: 0 0 4px;
  padding: 0 8px;
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-regular);
  color: var(--iu-text-muted);
}
.project__preview {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-lg, 8px);
  background: var(--iu-surface);
}
.project__bench[data-full] .project__preview {
  position: fixed;
  inset: 0;
  z-index: 50;
  border: 0;
  border-radius: 0;
}
.project__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.project__title {
  margin: 0;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-2);
}
.project__spacer {
  flex: 1 1 0;
}
.project__body {
  min-width: 0;
  padding: 4px 12px 12px;
}
.project__bench[data-full] .project__body {
  flex: 1;
  overflow: auto;
}
@media (max-width: 760px) {
  .project__bench {
    grid-template-columns: minmax(0, 1fr);
  }
  .project__side {
    position: static;
  }
  .project__side .project__nav {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .project__live {
    display: none;
  }
}
</style>
