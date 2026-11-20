<script setup lang="ts">
// A project's page, laid out like a session: the Overview is the page (compact header over it), and the project's
// other sections live in a docked panel on the right, the same pattern as the session's files/preview pane. The
// panel resizes, hides and goes full screen; its tab follows the route (/p/:name/files, /sessions, …), so links from
// the Overview open the right tab. On /p/:name/overview the panel keeps the tab it last showed.
import { computed, defineAsyncComponent, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ProjectDetail } from '@odin/shared/api'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { PROJECT_SECTIONS } from '@/app/router'
import { IuErrorState, IuSkeleton } from '@/components/States'
import { PREVIEW_MIN, useLayoutDemand } from '@/app/layout'
import { useSessions } from '@/app/sessions'
import type { Tab } from '@/components/Tabs'
import { useResource } from '@/screens/shared/useResource'
import ProjectHeader from './header/ProjectHeader.vue'
import OverviewScreen from './overview/OverviewScreen.vue'
import ProjectFilesPanel from './workbench/ProjectFilesPanel.vue'
import ProjectWorkbench from './workbench/ProjectWorkbench.vue'
import { PROJECT_KEY } from './useProject'

const props = defineProps<{ name: string }>()
const api = useApi()
const route = useRoute()
const router = useRouter()
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

const panels = {
  sessions: defineAsyncComponent(() => import('./sessions/ProjectSessionsScreen.vue')),
  outputs: defineAsyncComponent(() => import('./outputs/OutputsScreen.vue')),
  resources: defineAsyncComponent(() => import('./resources/ResourcesScreen.vue')),
  settings: defineAsyncComponent(() => import('./settings/ProjectSettingsScreen.vue')),
} as const
type PanelTab = 'files' | keyof typeof panels
// Files first, as in the session's preview pane; then the rest in the sections' order.
const PANEL_IDS: PanelTab[] = ['files', 'sessions', 'outputs', 'resources', 'settings']

const liveStore = useSessions()
const liveCount = computed(
  () => liveStore.active.value.filter(s => s.project === props.name).length,
)
const tabs = computed<Tab[]>(() =>
  PANEL_IDS.map(id => {
    const label = PROJECT_SECTIONS.find(s => s.id === id)!.label
    const d = detail.value
    const n =
      id === 'sessions'
        ? liveCount.value
        : id === 'files'
          ? (d?.dirtyFiles.length ?? 0)
          : id === 'resources'
            ? (d?.agents.length ?? 0)
            : 0
    return { id, label, ...(n ? { badge: n } : {}) }
  }),
)

// Per-viewer view state: open, width and last tab. Storage failures (private mode) are ignored.
function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}
const lastTab = ref<PanelTab>(
  PANEL_IDS.includes(read('odin.project.panel.tab') as PanelTab)
    ? (read('odin.project.panel.tab') as PanelTab)
    : 'files',
)
const open = ref(read('odin.project.panel') !== 'closed')
const width = ref(Math.max(PREVIEW_MIN, Number(read('odin.project.panel.width')) || 560))
const full = ref(false)
watch(open, v => write('odin.project.panel', v ? 'open' : 'closed'))
watch(width, v => write('odin.project.panel.width', String(Math.round(v))))

const routeTab = computed(() => {
  const s = route.meta.section as string | undefined
  return PANEL_IDS.includes(s as PanelTab) ? (s as PanelTab) : null
})
// A section route opens the panel on that tab.
watch(
  routeTab,
  t => {
    if (!t) return
    lastTab.value = t
    open.value = true
    write('odin.project.panel.tab', t)
  },
  { immediate: true },
)
const tab = computed<string>({
  get: () => routeTab.value ?? lastTab.value,
  set: id => void router.replace({ name: `project-${id}`, params: { name: props.name } }),
})
function closePanel() {
  open.value = false
  full.value = false
  if (routeTab.value)
    void router.replace({ name: 'project-overview', params: { name: props.name } })
}
function togglePanel() {
  if (open.value) closePanel()
  else open.value = true
}

// The header goes into the app's header band (one line with no separate breadcrumb); inline when there is no band.
const inBand = ref(false)
onMounted(() => (inBand.value = document.getElementById('app-header-project') !== null))

// Like the session screen: ask the app for room for the Overview plus the docked panel, so the app sidebar folds to
// its rail before the Overview gets cramped.
const OVERVIEW_MIN = 760
const setDemand = useLayoutDemand()
watch(open, v => setDemand(v ? OVERVIEW_MIN + PREVIEW_MIN : 0), { immediate: true })
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
      <div class="project__main">
        <Teleport to="#app-header-project" :disabled="!inBand">
          <ProjectHeader
            :detail="detail"
            :sync="sync"
            :panel-open="open"
            @toggle-panel="togglePanel"
          />
        </Teleport>
        <OverviewScreen />
      </div>
      <ProjectWorkbench
        v-if="open"
        v-model:tab="tab"
        v-model:full="full"
        :tabs="tabs"
        :width="width"
        @update:width="width = $event"
        @close="closePanel"
      >
        <ProjectFilesPanel v-if="tab === 'files'" />
        <div v-else class="project__panel">
          <component
            :is="panels[tab as keyof typeof panels]"
            v-bind="tab === 'sessions' ? { compact: !full } : {}"
          />
        </div>
      </ProjectWorkbench>
    </template>
  </div>
</template>

<style>
.project {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
}
.project__main {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 20px 20px;
  container-type: inline-size;
}
.project__panel {
  min-width: 0;
  padding: 4px 14px 14px;
}
</style>
