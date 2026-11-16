<script setup lang="ts">
// Tokens and cost by model over the range, the share of cost per model, and the harness share of sessions.
import { computed } from 'vue'
import type { MetricsRow } from '@odin/shared/api'
import { IuMeter } from '@/components/Meter'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { IuTable, type Column } from '@/components/Table'
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

interface Row extends Record<string, unknown> {
  model: string
  n: number
  tokens: string
  detail: string
  cached: string
  cost: string
}
const rows = computed<Row[]>(() =>
  modelRows.value.map(r => ({
    model: (r.key.model ?? '∅').replace(/^claude-/, ''),
    n: r.n,
    tokens: `${formatTokens(r.total.tokens.input)} / ${formatTokens(r.total.tokens.output)}`,
    cached: formatTokens(r.total.tokens.cacheRead + r.total.tokens.cacheWrite),
    detail: `${formatTokens(r.total.tokens.input)} in, ${formatTokens(r.total.tokens.output)} out, ${formatTokens(r.total.tokens.cacheRead + r.total.tokens.cacheWrite)} cached`,
    cost: formatCost(r.total.costUsd) || '—',
  })),
)
const columns: Column<Row>[] = [
  { key: 'model', header: 'Model' },
  { key: 'n', header: 'Sessions', align: 'end', numeric: true },
  { key: 'tokens', header: 'In / out', align: 'end', numeric: true },
  { key: 'cost', header: 'Cost', align: 'end', numeric: true },
]
const shares = computed(() =>
  totalCost.value > 0
    ? modelRows.value
        .filter(r => (r.total.costUsd ?? 0) > 0)
        .map(r => ({
          key: (r.key.model ?? '∅').replace(/^claude-/, ''),
          cost: r.total.costUsd ?? 0,
          share: (r.total.costUsd ?? 0) / totalCost.value,
        }))
        .sort((a, b) => b.cost - a.cost)
    : [],
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
      <div v-if="shares.length" class="ov-models__group">
        <h3 class="ov-models__label">Share of cost</h3>
        <IuMeter
          v-for="s in shares"
          :key="s.key"
          :value="s.share"
          :max="1"
          :label="s.key"
          :value-label="`${formatCost(s.cost)} · ${pct(s.share)}`"
        />
      </div>
      <IuTable
        :columns="columns"
        :rows="rows"
        :row-key="r => r.model"
        :sticky-header="false"
        density="compact"
      >
        <template #cell:model="{ row }">
          <code class="ov-models__mono">{{ row.model }}</code>
        </template>
        <template #cell:tokens="{ row }">
          <span :title="row.detail" class="ov-models__tokens"
            >{{ row.tokens }}<span class="ov-models__cached">{{ row.cached }} cached</span></span
          >
        </template>
      </IuTable>
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
.ov-models__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  white-space: nowrap;
}
.ov-models__tokens {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-end;
}
.ov-models__cached {
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
</style>
