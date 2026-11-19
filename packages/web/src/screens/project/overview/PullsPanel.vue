<script setup lang="ts">
// Pull requests opened by this project's sessions: open count, merged in the range, merge rate, median review
// rounds and the open list. Shown only when GitHub sync is on.
import { computed } from 'vue'
import type { Session } from '@odin/shared/api'
import { IuMetric } from '@/components/Metric'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import type { LoadError } from '@/screens/shared/useResource'
import { relativeTime } from '@/screens/shared/format'
import { pullsOf } from '../outputs/outputs'
import OverviewPanel from './OverviewPanel.vue'
import { median, mergeRate } from './overview'

const props = defineProps<{
  project: string
  sessions: Session[] | null
  since: string
  loading: boolean
  error: LoadError | null
}>()
const emit = defineEmits<{ retry: [] }>()

const withPull = computed(() => (props.sessions ?? []).filter(s => s.pull))
const pulls = computed(() => pullsOf(withPull.value))
const open = computed(() => pulls.value.filter(p => p.status === 'open'))
const mergedInRange = computed(
  () => pulls.value.filter(p => p.status === 'merged' && p.updatedAt >= props.since).length,
)
const rate = computed(() => mergeRate(withPull.value))
const rounds = computed(() =>
  median(withPull.value.filter(s => s.pull?.merged).map(s => s.metrics.reviewRounds)),
)
const stats = computed(() => [
  { label: 'Open', value: String(open.value.length) },
  { label: 'Merged in range', value: String(mergedInRange.value) },
  { label: 'Merge rate', value: rate.value === null ? '—' : `${Math.round(rate.value * 100)}%` },
  { label: 'Median review rounds', value: rounds.value === null ? '—' : String(rounds.value) },
])
</script>

<template>
  <OverviewPanel id="overview-pulls" title="Pull requests">
    <template #actions>
      <RouterLink
        :to="{ name: 'project-outputs', params: { name: project } }"
        class="ov-pulls__more"
        >All outputs</RouterLink
      >
    </template>
    <IuSkeleton v-if="loading && !sessions" shape="card" :rows="2" />
    <IuErrorState
      v-else-if="error && !sessions"
      title="Couldn't load the pull requests"
      :body="error.message"
      :trace-id="`project.sessions.${error.status}`"
      @retry="emit('retry')"
    />
    <IuEmpty
      v-else-if="!pulls.length"
      title="No pull requests yet"
      body="Pull requests opened by this project's sessions show up here."
    />
    <template v-else>
      <ul class="ov-pulls__stats">
        <li v-for="s in stats" :key="s.label">
          <IuMetric :label="s.label" :value="s.value" />
        </li>
      </ul>
      <ul v-if="open.length" class="ov-pulls__list" aria-label="Open pull requests">
        <li v-for="p in open" :key="p.pull.number" class="ov-pulls__row">
          <a :href="p.pull.url" target="_blank" rel="noopener noreferrer" class="ov-pulls__link"
            >#{{ p.pull.number }} {{ p.sessions[0]?.title }}</a
          >
          <span class="ov-pulls__muted"
            >open · <time :datetime="p.updatedAt">{{ relativeTime(p.updatedAt) }}</time></span
          >
        </li>
      </ul>
    </template>
  </OverviewPanel>
</template>

<style>
.ov-pulls__more {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  font-weight: var(--iu-font-weight-medium);
}
.ov-pulls__stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ov-pulls__stats > li {
  display: flex;
  min-width: 0;
}
.ov-pulls__stats > li > * {
  flex: 1;
  min-width: 0;
}
.ov-pulls__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ov-pulls__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  min-width: 0;
}
.ov-pulls__link {
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
  overflow-wrap: anywhere;
}
.ov-pulls__link:focus-visible,
.ov-pulls__more:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.ov-pulls__muted {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
