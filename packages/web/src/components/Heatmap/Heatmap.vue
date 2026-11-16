<script setup lang="ts">
// Calendar heatmap: seven rows (Monday first), one column per week, oldest on the left. Each cell's shade is its
// share of the busiest day, in `levels` steps; every cell has a title, and a visually hidden table carries the same
// numbers, so the picture is never the only way to read it. Nothing animates.
import { computed } from 'vue'
import { heatmapWeeks, type HeatmapDay } from './heatmap'

const props = withDefaults(
  defineProps<{
    days: HeatmapDay[]
    /** What the values are ("Sessions per day"). Names the grid and captions the table. */
    label: string
    levels?: number
    /** Text for a day's value in titles and the table. Defaults to the number. */
    format?: (value: number) => string
  }>(),
  { levels: 4, format: undefined },
)

defineSlots<{
  /** A short summary under the grid ("23 sessions in 12 weeks, busiest Tuesday"). */
  default?: () => unknown
}>()

const ROWS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']
const weeks = computed(() => heatmapWeeks(props.days, Math.max(1, props.levels)))
const text = (v: number) => (props.format ? props.format(v) : String(v))
const shade = (level: number) => level / Math.max(1, props.levels)
const legend = computed(() => Array.from({ length: Math.max(1, props.levels) + 1 }, (_, i) => i))
</script>

<template>
  <figure class="iu-heatmap">
    <div class="iu-heatmap__body" aria-hidden="true">
      <div class="iu-heatmap__rows">
        <span v-for="(r, i) in ROWS" :key="i">{{ r }}</span>
      </div>
      <div class="iu-heatmap__grid">
        <div v-for="(week, w) in weeks" :key="w" class="iu-heatmap__week">
          <span
            v-for="(cell, d) in week"
            :key="d"
            class="iu-heatmap__cell"
            :data-empty="cell ? undefined : ''"
            :data-level="cell?.level"
            :title="cell ? `${cell.date}: ${text(cell.value)}` : undefined"
            :style="cell ? { '--iu-heat': shade(cell.level) } : undefined"
          />
        </div>
      </div>
    </div>
    <div class="iu-heatmap__legend" aria-hidden="true">
      <span>Less</span>
      <span
        v-for="l in legend"
        :key="l"
        class="iu-heatmap__cell"
        :data-level="l"
        :style="{ '--iu-heat': shade(l) }"
      />
      <span>More</span>
    </div>
    <table class="sr-only">
      <caption>
        {{
          label
        }}
      </caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
          <th scope="col">Value</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in days" :key="d.date">
          <th scope="row">{{ d.date }}</th>
          <td>{{ text(d.value) }}</td>
        </tr>
      </tbody>
    </table>
    <figcaption v-if="$slots.default" class="iu-heatmap__summary"><slot /></figcaption>
  </figure>
</template>

<style>
.iu-heatmap {
  --iu-heat-cell: 11px;
  --iu-heat-gap: 3px;
  margin: 0;
  min-width: 0;
}
.iu-heatmap__body {
  display: flex;
  gap: 6px;
  overflow-x: auto;
}
.iu-heatmap__rows {
  display: grid;
  grid-template-rows: repeat(7, var(--iu-heat-cell));
  gap: var(--iu-heat-gap);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-10-5);
  line-height: var(--iu-heat-cell);
  color: var(--iu-text-muted);
}
.iu-heatmap__grid {
  display: flex;
  gap: var(--iu-heat-gap);
}
.iu-heatmap__week {
  display: grid;
  grid-template-rows: repeat(7, var(--iu-heat-cell));
  gap: var(--iu-heat-gap);
}
.iu-heatmap__cell {
  display: block;
  width: var(--iu-heat-cell);
  height: var(--iu-heat-cell);
  border-radius: var(--iu-radius-xs);
  background: color-mix(
    in oklab,
    var(--iu-accent) calc(var(--iu-heat, 0) * 100%),
    var(--iu-surface-sunken)
  );
  box-shadow: inset 0 0 0 1px var(--iu-hairline);
}
.iu-heatmap__cell[data-empty] {
  background: none;
  box-shadow: none;
}
.iu-heatmap__legend {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--iu-heat-gap);
  margin-top: 6px;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-10-5);
  color: var(--iu-text-muted);
}
.iu-heatmap__summary {
  margin-top: 8px;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text-2);
}
</style>
