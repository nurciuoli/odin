<script setup lang="ts">
// The main chart: one bar per day over the range, with a metric switch. Commits only for git projects.
import { computed, watch } from 'vue'
import type { ProjectActivityDay } from '@odin/shared/api'
import { IuBarChart } from '@/components/BarChart'
import { IuSegmented } from '@/components/Segmented'
import { IuErrorState, IuSkeleton } from '@/components/States'
import type { LoadError } from '@/screens/shared/useResource'
import { formatCost, plural } from '@/screens/shared/format'
import OverviewPanel from './OverviewPanel.vue'
import { formatDuration } from './overview'

type MetricId = 'sessions' | 'active' | 'cost' | 'commits'

const props = defineProps<{
  days: ProjectActivityDay[] | null
  git: boolean
  loading: boolean
  error: LoadError | null
}>()
const emit = defineEmits<{ retry: [] }>()
const metric = defineModel<MetricId>({ default: 'sessions' })

const METRICS: Record<
  MetricId,
  {
    label: string
    title: string
    value: (d: ProjectActivityDay) => number
    format: (v: number) => string
  }
> = {
  sessions: {
    label: 'Sessions',
    title: 'Sessions per day',
    value: d => d.sessions,
    format: v => plural(v, 'session'),
  },
  active: {
    label: 'Active time',
    title: 'Active time per day',
    value: d => d.activeMs,
    format: v => (v ? formatDuration(v) : '0m'),
  },
  cost: {
    label: 'Cost',
    title: 'Cost per day',
    value: d => d.costUsd ?? 0,
    format: v => formatCost(v),
  },
  commits: {
    label: 'Commits',
    title: 'Commits per day',
    value: d => d.commits ?? 0,
    format: v => plural(v, 'commit'),
  },
}

const options = computed(() =>
  (Object.keys(METRICS) as MetricId[])
    .filter(id => id !== 'commits' || props.git)
    .map(id => ({ value: id, label: METRICS[id].label })),
)
watch(
  () => props.git,
  git => {
    if (!git && metric.value === 'commits') metric.value = 'sessions'
  },
  { immediate: true },
)
const m = computed(() => METRICS[metric.value])
const bars = computed(() =>
  (props.days ?? []).map(d => ({ date: d.date, values: [m.value.value(d)] })),
)
const count = (v: number) => (Number.isInteger(v) ? String(v) : '')
const quiet = computed(() => bars.value.every(b => !b.values[0]))
const model = computed({
  get: () => metric.value as string,
  set: (v: string) => (metric.value = v as MetricId),
})
</script>

<template>
  <OverviewPanel id="overview-chart" :title="m.title">
    <template #actions>
      <IuSegmented v-model="model" :options="options" label="Chart metric" />
    </template>
    <IuSkeleton v-if="loading && !days" shape="card" :rows="3" />
    <IuErrorState
      v-else-if="error && !days"
      title="Couldn't load the activity"
      :body="error.message"
      :trace-id="`project.activity.${error.status}`"
      @retry="emit('retry')"
    />
    <template v-else>
      <IuBarChart
        :days="bars"
        :series="[{ key: metric, label: m.label, color: '--iu-viz-1' }]"
        :label="m.title"
        :format="m.format"
        :tick-format="metric === 'sessions' || metric === 'commits' ? count : m.format"
        :height="300"
      />
      <p v-if="quiet" class="ov-chart__note">Nothing in this range yet.</p>
    </template>
  </OverviewPanel>
</template>

<style>
.ov-chart__note {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
