<script setup lang="ts">
// Sums over the range, each with its change against the previous period of the same length. Git projects add
// lines changed by sessions and commits.
import { computed } from 'vue'
import { IuMetric } from '@/components/Metric'
import { IuErrorState } from '@/components/States'
import type { LoadError } from '@/screens/shared/useResource'
import { formatCost } from '@/screens/shared/format'
import { formatCount, formatDuration, percentChange, type PeriodTotals } from './overview'

const props = defineProps<{
  current: PeriodTotals | null
  previous: PeriodTotals | null
  git: boolean
  loading: boolean
  error: LoadError | null
}>()
const emit = defineEmits<{ retry: [] }>()

interface Tile {
  id: string
  label: string
  value: string
  change: number | null
  polarity: 'up-good' | 'up-bad' | 'neutral'
  footer?: string
}

const tiles = computed<Tile[]>(() => {
  const c = props.current
  const p = props.previous
  if (!c) return []
  const out: Tile[] = [
    {
      id: 'sessions',
      label: 'Sessions',
      value: formatCount(c.sessions),
      change: percentChange(c.sessions, p?.sessions ?? null),
      polarity: 'neutral',
    },
    {
      id: 'active',
      label: 'Active time',
      value: c.activeMs ? formatDuration(c.activeMs) : '0m',
      change: percentChange(c.activeMs, p?.activeMs ?? null),
      polarity: 'neutral',
    },
    {
      id: 'cost',
      label: 'Cost',
      value: formatCost(c.costUsd ?? 0),
      change: percentChange(c.costUsd, p?.costUsd ?? null),
      polarity: 'up-bad',
    },
  ]
  if (props.git) {
    out.push(
      {
        id: 'lines',
        label: 'Lines changed',
        value: `+${formatCount(c.added)} −${formatCount(c.removed)}`,
        change: null,
        polarity: 'neutral',
        footer: 'Added and removed by sessions',
      },
      {
        id: 'commits',
        label: 'Commits',
        value: formatCount(c.commits ?? 0),
        change: percentChange(c.commits, p?.commits ?? null),
        polarity: 'neutral',
      },
    )
  }
  return out
})
const placeholders = computed(() =>
  props.git
    ? ['Sessions', 'Active time', 'Cost', 'Lines changed', 'Commits']
    : ['Sessions', 'Active time', 'Cost'],
)
</script>

<template>
  <section aria-labelledby="overview-totals" class="ov-totals">
    <h2 id="overview-totals" class="ov-totals__sr">Totals for the range</h2>
    <IuErrorState
      v-if="error && !current"
      title="Couldn't load the totals"
      :body="error.message"
      :trace-id="`project.activity.${error.status}`"
      @retry="emit('retry')"
    />
    <ul v-else class="ov-totals__list">
      <template v-if="loading && !current">
        <li v-for="label in placeholders" :key="label">
          <IuMetric :label="label" value="" state="loading" />
        </li>
      </template>
      <li v-for="t in tiles" v-else :key="t.id">
        <IuMetric
          :label="t.label"
          :value="t.value"
          :polarity="t.polarity"
          :delta="t.change === null ? undefined : { value: t.change, label: 'vs previous period' }"
        >
          <template v-if="t.footer || (t.change === null && t.id !== 'lines')" #footer>
            <p class="ov-totals__note">{{ t.footer ?? 'No earlier activity to compare' }}</p>
          </template>
        </IuMetric>
      </li>
    </ul>
  </section>
</template>

<style>
.ov-totals__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.ov-totals__list {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(128px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ov-totals__list > li {
  display: flex;
  min-width: 0;
}
.ov-totals__list > li > * {
  flex: 1;
  min-width: 0;
}
.ov-totals__note {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
