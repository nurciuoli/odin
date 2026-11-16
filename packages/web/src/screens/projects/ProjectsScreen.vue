<script setup lang="ts">
// Every project as a card: recent activity, live counts, sync state and open PRs; busiest first.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { useSessions } from '@/app/sessions'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCard } from '@/components/Card'
import { IuField } from '@/components/Fields'
import { IuPageHeader } from '@/components/PageHeader'
import { IuSparkline } from '@/components/Sparkline'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import SyncBadge from '@/screens/shared/SyncBadge.vue'
import { plural, relativeTime } from '@/screens/shared/format'
import { useResource } from '@/screens/shared/useResource'
import { openPullCounts, sortProjects } from './projectsIndex'

const api = useApi()
const store = useProjects()
const live = useSessions()

// Open PR counts come from sessions; the cards render without them.
const sessions = useResource<Session[]>(() => api.listSessions({ archived: false }))
void sessions.load()
let timer: ReturnType<typeof setTimeout> | undefined
watch(live.revision, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void sessions.load(), 500)
})
onBeforeUnmount(() => clearTimeout(timer))
const pulls = computed(() => openPullCounts(sessions.data.value ?? []))

const filter = ref('')
const cards = computed(() =>
  sortProjects(store.projects.value, filter.value).map(p => ({
    ...p,
    live: live.countsFor(p.name),
  })),
)
</script>

<template>
  <div class="projects">
    <IuPageHeader title="Projects" icon="folder">
      <template #actions>
        <IuButton as="RouterLink" to="/projects/new" variant="secondary" size="sm"
          >Add project</IuButton
        >
      </template>
    </IuPageHeader>

    <div class="projects__filter">
      <IuField
        :model-value="filter"
        label="Filter projects"
        type="search"
        placeholder="Name, title or repo"
        @update:model-value="v => (filter = String(v ?? ''))"
      />
    </div>

    <IuSkeleton v-if="store.loading.value" shape="card" :rows="3" />
    <IuErrorState
      v-else-if="store.error.value"
      title="Couldn't load the projects"
      :body="String(store.error.value)"
      trace-id="projects.list"
      @retry="store.reload()"
    />
    <IuEmpty
      v-else-if="!store.projects.value.length"
      title="No projects yet"
      body="Add a git repository to start working in it."
    />
    <IuEmpty v-else-if="!cards.length" title="No matches" body="No project matches the filter." />
    <ul v-else class="projects__grid" aria-label="Projects">
      <li v-for="p in cards" :key="p.name">
        <IuCard density="compact" class="projects__card">
          <div class="projects__head">
            <RouterLink
              :to="{ name: 'project-overview', params: { name: p.name } }"
              class="projects__title"
              >{{ p.title }}</RouterLink
            >
            <IuBadge v-if="p.missing" intent="warning">Folder missing</IuBadge>
            <SyncBadge :sync="p.sync" />
          </div>
          <p v-if="p.description" class="projects__text">{{ p.description }}</p>
          <IuSparkline
            :values="p.activity"
            :label="`${p.title}: sessions per day, last 14 days`"
            :height="32"
            area
          />
          <p class="projects__counts">
            <IuBadge v-if="p.live.waiting" intent="warning">{{ p.live.waiting }} waiting</IuBadge>
            <IuBadge v-if="p.live.running" intent="accent" dot
              >{{ p.live.running }} running</IuBadge
            >
            <span v-if="pulls.get(p.name)">{{ plural(pulls.get(p.name)!, 'open PR') }}</span>
            <span class="projects__muted">Updated {{ relativeTime(p.updatedAt) }}</span>
          </p>
        </IuCard>
      </li>
    </ul>
  </div>
</template>

<style>
.projects {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.projects__filter {
  max-width: 360px;
}
.projects__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.projects__card {
  height: 100%;
}
.projects__head,
.projects__counts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.projects__counts {
  margin: 8px 0;
  font-size: var(--iu-font-size-12);
}
.projects__title {
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text);
}
.projects__title:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.projects__text {
  margin: 6px 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.projects__muted {
  color: var(--iu-text-muted);
}
</style>
