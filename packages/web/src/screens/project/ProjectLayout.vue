<script setup lang="ts">
// A project's page: the header (title, branch, quick actions, Start chat) over the tab strip and the tab itself.
import { computed, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ProjectDetail } from '@odin/shared/api'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { PROJECT_SECTIONS } from '@/app/router'
import { IuErrorState, IuSkeleton } from '@/components/States'
import type { Tab } from '@/components/Tabs'
import { useResource } from '@/screens/shared/useResource'
import ProjectHeader from './header/ProjectHeader.vue'
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
      <ProjectHeader
        v-model="section"
        :detail="detail"
        :sync="sync"
        :tabs="tabs"
        id-base="project"
      />
      <div
        :id="`project-panel-${section}`"
        role="tabpanel"
        :aria-labelledby="`project-tab-${section}`"
      >
        <RouterView />
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
</style>
