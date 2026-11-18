<script setup lang="ts">
// One list of cost by model over the range (share bar, sessions and tokens under each name), plus the harness share of sessions.
import { computed } from 'vue'
import type { MetricsRow } from '@odin/shared/api'
import { IuMeter } from '@/components/Meter'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { formatCost, formatTokens, harnessLabel } from '@/screens/shared/format'
import OverviewPanel from './OverviewPanel.vue'
import type { Settled } from './settled'

const props = defineProps<{
  project: string
  models: Settled<MetricsRow[]> | null
  harnesses: Settled<MetricsRow[]> | null
  loading: boolean
}>()
const emit = defineEmits<{ retry: [] }>()

const pct = (x: number) => `${Math.round(x * 100)}%`
const modelRows = computed(() => (props.models?.ok ? props.models.value : []))
const totalCost = computed(() => modelRows.value.reduce((t, r) => t + (r.total.costUsd ?? 0), 0))

interface Row {
  model: string
  cost: number
  costLabel: string
  share: number
  meta: string
  detail: string
}
const rows = computed<Row[]>(() =>
  modelRows.value
    .map(r => {
      const t = r.total.tokens
      const cost = r.total.costUsd ?? 0
      const cached = formatTokens(t.cacheRead + t.cacheWrite)
      return {
        model: (r.key.model ?? '∅').replace(/^claude-/, ''),
        cost,
        costLabel: formatCost(r.total.costUsd) || '—',
        share: totalCost.value > 0 ? cost / totalCost.value : 0,
        meta: `${r.n} ${r.n === 1 ? 'session' : 'sessions'} · ${formatTokens(t.input)} in · ${formatTokens(t.output)} out`,
        detail: `${formatTokens(t.input)} in, ${formatTokens(t.output)} out, ${cached} cached`,
      }
    })
    .sort((a, b) => b.cost - a.cost),
)
const harnessShares = computed(() => {
  const rows = props.harnesses?.ok ? props.harnesses.value : []
  const n = rows.reduce((t, r) => t + r.n, 0)
  const byLabel = new Map<string, number>()
  for (const r of rows) {
    const label = harnessLabel(r.key.harness ?? '')
    byLabel.set(label, (byLabel.get(label) ?? 0) + r.n)
  }
  return [...byLabel]
    .map(([label, count]) => ({ label, count, share: n ? count / n : 0 }))
    .sort((a, b) => b.count - a.count)
})
const failed = computed(() => (props.models && !props.models.ok ? props.models.error : null))
</script>

<template>
  <OverviewPanel id="overview-models" title="Models">
    <template #actions>
      <RouterLink :to="{ name: 'compare', query: { project } }" class="ov-models__more"
        >Open in Compare</RouterLink
      >
    </template>
    <IuSkeleton v-if="loading && !models" shape="table" :rows="3" />
    <IuErrorState
      v-else-if="failed"
      title="Couldn't load the metrics"
      :body="failed.message"
      :trace-id="`project.metrics.${failed.status}`"
      @retry="emit('retry')"
    />
    <IuEmpty
      v-else-if="!rows.length"
      title="No sessions in this range"
      body="Pick a longer range to see tokens and cost by model."
    />
    <template v-else>
      <ul class="ov-models__list" aria-label="Cost by model">
        <li v-for="r in rows" :key="r.model" class="ov-models__row" :title="r.detail">
          <code class="ov-models__mono">{{ r.model }}</code>
          <span class="ov-models__num">{{ r.costLabel }}</span>
          <span class="ov-models__pct">{{ r.cost > 0 ? pct(r.share) : '' }}</span>
          <IuMeter
            class="ov-models__bar"
            :value="r.share"
            :max="1"
            :aria-label="`${r.model} share of cost`"
            intent="neutral"
            value-label=" "
          />
          <span class="ov-models__meta">{{ r.meta }}</span>
        </li>
      </ul>
      <div v-if="harnessShares.length" class="ov-models__group ov-models__group--rule">
        <h3 class="ov-models__label">Harness, share of sessions</h3>
        <IuMeter
          v-for="h in harnessShares"
          :key="h.label"
          :value="h.share"
          :max="1"
          :label="h.label"
          :value-label="`${h.count} · ${pct(h.share)}`"
          intent="neutral"
          layout="inline"
        />
      </div>
    </template>
  </OverviewPanel>
</template>

<style>
.ov-models__more {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  font-weight: var(--iu-font-weight-medium);
}
.ov-models__more:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.ov-models__group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ov-models__group--rule {
  padding-top: 12px;
  border-top: 1px solid var(--iu-border-quiet);
}
.ov-models__label {
  margin: 0;
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-regular);
  color: var(--iu-text-muted);
}
.ov-models__list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ov-models__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 3ch;
  column-gap: 12px;
  row-gap: 4px;
  align-items: baseline;
  min-width: 0;
}
.ov-models__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-models__num,
.ov-models__pct {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  text-align: end;
  font-variant-numeric: tabular-nums;
}
.ov-models__pct {
  color: var(--iu-text-muted);
}
.ov-models__bar,
.ov-models__meta {
  grid-column: 1 / -1;
}
.ov-models__meta {
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
