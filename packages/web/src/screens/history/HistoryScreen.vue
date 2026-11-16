<script setup lang="ts">
// Every session across projects in one table. Filters, search and the Archived switch live in the URL.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { useSessions } from '@/app/sessions'
import { IuButton } from '@/components/Button'
import { IuSwitch } from '@/components/Fields'
import { IuFilterBar, type Clause } from '@/components/FilterBar'
import { IuPageHeader } from '@/components/PageHeader'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import SessionsTable from '@/screens/shared/SessionsTable.vue'
import { plural } from '@/screens/shared/format'
import { useResource } from '@/screens/shared/useResource'
import {
  applyClauses,
  filterFields,
  queryFromState,
  sameQuery,
  stateFromQuery,
} from './historyQuery'

const api = useApi()
const route = useRoute()
const router = useRouter()
const projects = useProjects()
const live = useSessions()

// ── URL ↔ filter state ─────────────────────────────────────────────────────
const initial = stateFromQuery(route.query)
const clauses = ref<Clause[]>(initial.clauses)
const q = ref(initial.q)
const archived = ref(initial.archived)

const current = () =>
  queryFromState({ q: q.value, clauses: clauses.value, archived: archived.value })

// Back/forward and links change the URL; take it in only when it says something different from what we show.
watch(
  () => route.query,
  query => {
    if (route.name !== 'history' || sameQuery(query, current())) return
    const next = stateFromQuery(query)
    clauses.value = next.clauses
    q.value = next.q
    archived.value = next.archived
  },
)
watch([q, clauses, archived], () => {
  if (route.name !== 'history' || sameQuery(route.query, current())) return
  void router.replace({ query: current() })
})

// ── data ────────────────────────────────────────────────────────────────────
// Search and the archive switch go to the server; the clauses filter what comes back.
const res = useResource<Session[]>(() =>
  api.listSessions({ archived: archived.value, ...(q.value ? { q: q.value } : {}) }),
)
watch([q, archived], () => void res.load(), { immediate: true })

let timer: ReturnType<typeof setTimeout> | undefined
watch(live.revision, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void res.load(), 250)
})
onBeforeUnmount(() => clearTimeout(timer))

const all = computed(() => res.data.value ?? [])
const fields = computed(() => filterFields(all.value, projects.projects.value))
const shown = computed(() => applyClauses(all.value, clauses.value))
const filtered = computed(() => !!q.value || clauses.value.some(c => c.value !== null))

function clearFilters() {
  clauses.value = []
  q.value = ''
}
</script>

<template>
  <div class="history">
    <IuPageHeader
      title="Sessions"
      :subtitle="
        res.phase.value === 'ready'
          ? `${plural(shown.length, 'session')}${archived ? ' (including archived)' : ''}`
          : 'Every session across your projects'
      "
      icon="clock"
    >
      <template #actions>
        <IuButton as="router-link" to="/?launch=1" variant="primary">New session</IuButton>
      </template>
    </IuPageHeader>

    <div class="history__toolbar">
      <div class="history__filters">
        <IuFilterBar v-model="clauses" v-model:q="q" :fields="fields" :sync-url="false" />
      </div>
      <IuSwitch v-model="archived" label="Archived" />
    </div>

    <IuSkeleton v-if="res.phase.value === 'loading'" shape="table" :rows="6" />
    <IuErrorState
      v-else-if="res.phase.value === 'error'"
      title="Couldn't load the history"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`history.load.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />
    <IuEmpty
      v-else-if="!shown.length && filtered"
      kind="filtered"
      title="No sessions match"
      body="Loosen a filter or clear the search."
    >
      <IuButton variant="secondary" @click="clearFilters">Clear filters</IuButton>
    </IuEmpty>
    <IuEmpty
      v-else-if="!shown.length"
      title="No sessions yet"
      :body="
        archived
          ? 'Nothing is archived.'
          : 'Start one from Home. Terminal sessions in a project show up after you find them in its Sessions tab.'
      "
    />
    <SessionsTable v-else :sessions="shown" @changed="res.load()" />
  </div>
</template>

<style>
.history {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 16px;
}
.history__toolbar {
  display: flex;
  align-items: flex-start;
  gap: 16px;
}
.history__filters {
  flex: 1;
  min-width: 0;
}
.history__toolbar .iu-switch-row {
  flex: none;
  gap: 8px;
  padding-top: 4px;
}
</style>
