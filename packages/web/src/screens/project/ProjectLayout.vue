<script setup lang="ts">
// A project's page: header (title, path, repo, git state, sync, Start chat, "open in…" on desktop)
// over the tab strip and the tab itself.
import { computed, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ProjectDetail } from '@odin/shared/api'
import { useApi } from '@/api'
import { hasDesktop, openPath, OPEN_TARGETS, type OpenTarget } from '@/app/desktop'
import { useProjects } from '@/app/projects'
import { PROJECT_SECTIONS } from '@/app/router'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuMenu } from '@/components/Menu'
import { IuPageHeader } from '@/components/PageHeader'
import { IuErrorState, IuSkeleton } from '@/components/States'
import { IuTabs, type Tab } from '@/components/Tabs'
import { useToast } from '@/components/Toast'
import SyncBadge from '@/screens/shared/SyncBadge.vue'
import { useResource } from '@/screens/shared/useResource'
import { PROJECT_KEY } from './useProject'

const props = defineProps<{ name: string }>()
const api = useApi()
const route = useRoute()
const router = useRouter()
const store = useProjects()
const { toast } = useToast()

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

const git = computed(() => detail.value?.git)
const repoUrl = computed(() =>
  detail.value?.repo ? `https://github.com/${detail.value.repo}` : null,
)

const tabs = computed<Tab[]>(() =>
  PROJECT_SECTIONS.map(s => ({
    id: s.id,
    label: s.label,
  })),
)
const section = computed({
  get: () => (route.meta.section as string | undefined) ?? 'overview',
  set: id => void router.push({ name: `project-${id}`, params: { name: props.name } }),
})

const desktop = hasDesktop()
const openItems = OPEN_TARGETS.map(t => ({ id: t.id, label: t.label }))
async function openIn(target: string) {
  if (!detail.value) return
  if (!(await openPath(detail.value.path, target as OpenTarget)))
    toast({ title: "Couldn't open the folder", intent: 'danger' })
}
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
      <IuPageHeader :title="detail.title" icon="folder" wrap>
        <template #subtitle>
          <span class="project__path">{{ detail.path }}</span>
        </template>
        <template #status>
          <IuBadge v-if="detail.missing" intent="warning">Folder missing</IuBadge>
          <SyncBadge v-if="sync" :sync="sync" />
        </template>
        <template #actions>
          <IuButton
            as="RouterLink"
            :to="{ name: 'home', query: { launch: '1', project: detail.name } }"
            variant="primary"
            size="sm"
            >Start chat</IuButton
          >
          <IuMenu v-if="desktop" :items="openItems" @select="openIn">
            <template #trigger="{ toggle, open }">
              <IuButton
                variant="secondary"
                size="sm"
                aria-haspopup="menu"
                :aria-expanded="open ? 'true' : 'false'"
                @click="toggle"
              >
                Open in…
                <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
              </IuButton>
            </template>
          </IuMenu>
        </template>
      </IuPageHeader>

      <ul
        v-if="repoUrl || git?.branch || git?.dirty"
        class="project__chips"
        aria-label="Repository"
      >
        <li v-if="repoUrl">
          <a :href="repoUrl" target="_blank" rel="noopener noreferrer" class="project__chip">
            <IuIcon name="gitBranch" :size="14" /> {{ detail.repo }}
          </a>
        </li>
        <li v-if="git?.branch">
          <IuBadge variant="tag">
            <code class="project__code">{{ git.branch }}</code>
            <code v-if="git.headSha" class="project__code" :title="git.headSha">{{
              git.headSha.slice(0, 7)
            }}</code>
          </IuBadge>
        </li>
        <li v-if="git && git.ahead > 0">
          <IuBadge variant="tag" :aria-label="`${git.ahead} commits ahead`"
            >↑{{ git.ahead }} ahead</IuBadge
          >
        </li>
        <li v-if="git && git.behind > 0">
          <IuBadge variant="tag" :aria-label="`${git.behind} commits behind`"
            >↓{{ git.behind }} behind</IuBadge
          >
        </li>
        <li v-if="git?.dirty">
          <IuBadge intent="warning">Uncommitted changes</IuBadge>
        </li>
      </ul>

      <IuTabs v-model="section" :tabs="tabs" aria-label="Project sections">
        <template v-for="s in PROJECT_SECTIONS" :key="s.id" #[`panel:${s.id}`]>
          <RouterView v-if="section === s.id" />
        </template>
      </IuTabs>
    </template>
  </div>
</template>

<style>
.project {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.project__path {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.project__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.project__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-md);
  color: var(--iu-text);
  font-size: var(--iu-font-size-12);
}
.project__chip:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.project__code {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
</style>
