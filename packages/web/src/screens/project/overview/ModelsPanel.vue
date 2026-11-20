<script setup lang="ts">
// Cost by model over the range: the top few models with a share bar and sessions/tokens under each name; the rest fold
// into a "N more" row that opens a compact, scrollable one-line-per-model list, so the card stays the same size
// however many models a project has used. The harness share of sessions is one line of text.
import { computed, ref } from 'vue'
import type { MetricsRow } from '@odin/shared/api'
import { IuIcon } from '@/components/Icon'
import { IuMeter } from '@/components/Meter'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { formatCost, formatTokens, harnessLabel } from '@/screens/shared/format'
import OverviewPanel from './OverviewPanel.vue'
import type { Settled } from './settled'

const props = defineProps<{
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
const TOP = 5
const top = computed(() => rows.value.slice(0, TOP))
const rest = computed(() => rows.value.slice(TOP))
const restCost = computed(() => rest.value.reduce((t, r) => t + r.cost, 0))
const showRest = ref(false)
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
        <li v-for="r in top" :key="r.model" class="ov-models__row" :title="r.detail">
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
      <div v-if="rest.length" class="ov-models__rest">
        <button
          type="button"
          class="ov-models__toggle"
          :aria-expanded="showRest"
          aria-controls="ov-models-rest"
          @click="showRest = !showRest"
        >
          <IuIcon :name="showRest ? 'chevronDown' : 'chevronRight'" :size="14" />
          {{ showRest ? 'Hide' : `${rest.length} more models` }}
          <span v-if="!showRest" class="ov-models__muted"
            >{{ formatCost(restCost) || '—' }} combined</span
          >
        </button>
        <ul
          v-show="showRest"
          id="ov-models-rest"
          class="ov-models__more"
          aria-label="More models by cost"
        >
          <li v-for="r in rest" :key="r.model" class="ov-models__line" :title="r.detail">
            <code class="ov-models__mono">{{ r.model }}</code>
            <span class="ov-models__muted">{{ r.meta.split(' · ')[0] }}</span>
            <span class="ov-models__num">{{ r.costLabel }}</span>
          </li>
        </ul>
      </div>
      <p v-if="harnessShares.length" class="ov-models__harness">
        <span class="ov-models__muted">Harness</span>
        <span v-for="h in harnessShares" :key="h.label"
          >{{ h.label }} <b>{{ pct(h.share) }}</b></span
        >
      </p>
    </template>
  </OverviewPanel>
</template>

<style>
.ov-models__rest {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--iu-border-quiet);
}
.ov-models__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--iu-text-2);
  font: inherit;
  font-size: var(--iu-font-size-12);
  cursor: pointer;
}
.ov-models__toggle:hover {
  color: var(--iu-text-bright);
}
.ov-models__toggle:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.ov-models__more {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  max-height: 168px;
  overflow-y: auto;
  list-style: none;
}
.ov-models__line {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 12px;
  align-items: baseline;
}
.ov-models__line .ov-models__num {
  min-width: 7ch;
}
.ov-models__muted {
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.ov-models__harness {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.ov-models__harness b {
  font-family: var(--iu-font-mono);
  font-weight: var(--iu-font-weight-regular);
  color: var(--iu-text-muted);
}
.ov-models__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
