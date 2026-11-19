<script setup lang="ts">
// What a project's sessions produced: artifacts (each opens its session with the artifact selected) and pull requests.
import { computed, onBeforeUnmount, watch } from 'vue'
import type { Artifact, Session } from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import { useApi } from '@/api'
import { useSessions } from '@/app/sessions'
import { IuBadge } from '@/components/Badge'
import { IuCard } from '@/components/Card'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { relativeTime } from '@/screens/shared/format'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import { useFlagged } from '@/composables/useFlagged'
import { useProject } from '../useProject'
import { pullsOf } from './outputs'

const api = useApi()
const live = useSessions()
const { detail } = useProject()
const name = computed(() => detail.value.name)

const artifacts = useResource<Artifact[]>(() => api.listProjectArtifacts(name.value))
const sessions = useResource<Session[]>(() => api.listSessions({ project: name.value }))
watch(
  name,
  () => {
    artifacts.reset()
    sessions.reset()
    void artifacts.load()
    void sessions.load()
  },
  { immediate: true },
)

let timer: ReturnType<typeof setTimeout> | undefined
watch(live.revision, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void sessions.load(), 250)
})
onBeforeUnmount(() => clearTimeout(timer))
useServerEvents(
  (e: ServerEvent) => {
    if (e.type === 'artifact.updated') void artifacts.load()
  },
  () => {
    void artifacts.load()
    void sessions.load()
  },
)

const titles = computed(() => new Map((sessions.data.value ?? []).map(s => [s.id, s.title])))
const pulls = computed(() => pullsOf(sessions.data.value ?? []))

// A pull request that is merged while this screen is open gets one quiet shimmer across its number.
const { flagged: justMerged, flag: flagMerged } = useFlagged<number>(1600)
const pullStatus = new Map<number, string>()
watch(
  pulls,
  list => {
    for (const p of list) {
      if (pullStatus.get(p.pull.number) === 'open' && p.status === 'merged')
        flagMerged(p.pull.number)
      pullStatus.set(p.pull.number, p.status)
    }
  },
  { immediate: true },
)
const PULL_DISPLAY = {
  merged: { intent: 'positive', label: 'Merged' },
  open: { intent: 'accent', label: 'Open' },
  closed: { intent: 'neutral', label: 'Closed' },
} as const
</script>

<template>
  <div class="outputs">
    <section aria-labelledby="outputs-artifacts" class="outputs__section">
      <h2 id="outputs-artifacts" class="outputs__heading">Artifacts</h2>
      <IuSkeleton v-if="artifacts.phase.value === 'loading'" shape="card" :rows="2" />
      <IuErrorState
        v-else-if="artifacts.phase.value === 'error'"
        title="Couldn't load the artifacts"
        :body="artifacts.error.value?.message ?? 'Unknown error'"
        :trace-id="`project.artifacts.${artifacts.error.value?.status ?? 0}`"
        @retry="artifacts.load()"
      />
      <IuEmpty
        v-else-if="!artifacts.data.value?.length"
        title="No artifacts yet"
        body="Pages and tools agents post in this project's sessions show up here."
      />
      <ul v-else class="outputs__grid" aria-label="Artifacts">
        <li v-for="a in artifacts.data.value" :key="a.id">
          <IuCard density="compact">
            <RouterLink
              :to="{
                name: 'session',
                params: { id: a.sessionId },
                query: { artifact: String(a.id) },
              }"
              class="outputs__title"
              >{{ a.title }}</RouterLink
            >
            <p class="outputs__meta">
              <IuBadge variant="tag" size="xs">v{{ a.latestVersion }}</IuBadge>
              <span>{{ titles.get(a.sessionId) ?? 'Session' }}</span>
              <time :datetime="a.updatedAt" :title="a.updatedAt">{{
                relativeTime(a.updatedAt)
              }}</time>
            </p>
          </IuCard>
        </li>
      </ul>
    </section>

    <section aria-labelledby="outputs-pulls" class="outputs__section">
      <h2 id="outputs-pulls" class="outputs__heading">Pull requests</h2>
      <IuSkeleton v-if="sessions.phase.value === 'loading'" shape="row" :rows="3" />
      <IuErrorState
        v-else-if="sessions.phase.value === 'error'"
        title="Couldn't load the sessions"
        :body="sessions.error.value?.message ?? 'Unknown error'"
        :trace-id="`project.pulls.${sessions.error.value?.status ?? 0}`"
        @retry="sessions.load()"
      />
      <IuEmpty
        v-else-if="!pulls.length"
        title="No pull requests"
        body="Pull requests opened from this project's sessions show up here."
      />
      <ul v-else class="outputs__pulls" aria-label="Pull requests">
        <li v-for="p in pulls" :key="p.pull.number" class="outputs__pull">
          <a
            :href="p.pull.url"
            target="_blank"
            rel="noopener noreferrer"
            class="outputs__title"
            :class="{ 'iu-shimmer': justMerged.has(p.pull.number) }"
            >#{{ p.pull.number }}</a
          >
          <IuBadge :intent="PULL_DISPLAY[p.status].intent" dot>{{
            PULL_DISPLAY[p.status].label
          }}</IuBadge>
          <span class="outputs__meta">
            <RouterLink
              v-for="s in p.sessions"
              :key="s.id"
              :to="{ name: 'session', params: { id: s.id } }"
              >{{ s.title }}</RouterLink
            >
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style>
.outputs {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding-top: 8px;
}
.outputs__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.outputs__heading {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.outputs__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.outputs__pulls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.outputs__pull {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.outputs__title {
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.outputs__title:focus-visible,
.outputs__meta a:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.outputs__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  margin: 6px 0 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
</style>
