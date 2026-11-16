<script setup lang="ts">
// Lines added (above the axis) and removed (below) per day by the range's sessions. Git projects only.
import { computed } from 'vue'
import type { ProjectActivityDay } from '@odin/shared/api'
import { IuBarChart } from '@/components/BarChart'
import { IuErrorState, IuSkeleton } from '@/components/States'
import type { LoadError } from '@/screens/shared/useResource'
import OverviewPanel from './OverviewPanel.vue'
import { formatCount } from './overview'

const props = defineProps<{
  days: ProjectActivityDay[] | null
  loading: boolean
  error: LoadError | null
}>()
const emit = defineEmits<{ retry: [] }>()

const bars = computed(() =>
  (props.days ?? []).map(d => ({ date: d.date, values: [d.added, d.removed] })),
)
const quiet = computed(() => bars.value.every(b => !b.values[0] && !b.values[1]))
const short = (v: number) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : formatCount(v))
</script>

<template>
  <OverviewPanel id="overview-code" title="Code changed by sessions">
    <IuSkeleton v-if="loading && !days" shape="card" :rows="2" />
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
        :series="[
          { key: 'added', label: 'Added', color: '--iu-viz-gain' },
          { key: 'removed', label: 'Removed', color: '--iu-viz-loss' },
        ]"
        mode="diverging"
        label="Lines changed by sessions per day"
        :format="short"
        :height="200"
      />
      <p class="ov-code__note">
        {{
          quiet ? 'No session changed code in this range.' : 'Added above the line, removed below.'
        }}
      </p>
    </template>
  </OverviewPanel>
</template>

<style>
.ov-code__note {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
