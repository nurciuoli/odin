<script setup lang="ts">
// Medians over the range's sessions, from the single ungrouped metrics row.
import { computed } from 'vue'
import type { MetricsRow } from '@odin/shared/api'
import { IuMetric } from '@/components/Metric'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { formatCost } from '@/screens/shared/format'
import OverviewPanel from './OverviewPanel.vue'
import { formatDuration } from './overview'
import type { Settled } from './settled'

const props = defineProps<{ typical: Settled<MetricsRow[]> | null; loading: boolean }>()
const emit = defineEmits<{ retry: [] }>()

const row = computed(() => (props.typical?.ok ? (props.typical.value[0] ?? null) : null))
const failed = computed(() => (props.typical && !props.typical.ok ? props.typical.error : null))
const num = (v: number | null) => (v === null ? '—' : String(Math.round(v)))
const stats = computed(() => {
  const m = row.value?.median
  if (!m) return []
  return [
    { label: 'Active time', value: formatDuration(m.activeMs) },
    { label: 'Cost', value: formatCost(m.costUsd) || '—' },
    { label: 'Turns', value: num(m.turns) },
    { label: 'Tool calls', value: num(m.toolCalls) },
  ]
})
</script>

<template>
  <OverviewPanel id="overview-typical" title="Typical session">
    <IuSkeleton v-if="loading && !typical" shape="card" :rows="2" />
    <IuErrorState
      v-else-if="failed"
      title="Couldn't load the metrics"
      :body="failed.message"
      :trace-id="`project.metrics.${failed.status}`"
      @retry="emit('retry')"
    />
    <IuEmpty
      v-else-if="!row || !row.n"
      title="No sessions in this range"
      body="Medians appear once a session runs in the range."
    />
    <template v-else>
      <ul class="ov-typical">
        <li v-for="s in stats" :key="s.label">
          <IuMetric :label="s.label" :value="s.value" />
        </li>
      </ul>
      <p class="ov-typical__note">
        Medians over {{ row.n }} session{{ row.n === 1 ? '' : 's'
        }}{{ row.lowConfidence ? ', a small sample' : '' }} in the range.
      </p>
    </template>
  </OverviewPanel>
</template>

<style>
.ov-typical {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ov-typical > li {
  display: flex;
  min-width: 0;
}
.ov-typical > li > * {
  flex: 1;
  min-width: 0;
}
.ov-typical__note {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
