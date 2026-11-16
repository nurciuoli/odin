<script setup lang="ts">
// Daily bar chart on one y axis: one or two series, grouped side by side, or diverging (series 1 above the axis,
// series 2 below, for added/removed). Never two scales. Each day has a hit target wider than its bars: hover or
// focus shows a tooltip with the date and values. The hit targets are one tab stop; arrow keys move between days.
// A visually hidden table carries the same numbers. Nothing animates beyond a tooltip fade (off under
// prefers-reduced-motion).
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import {
  barPath,
  barSlot,
  dateTickIndices,
  domain,
  niceTicks,
  shortDate,
  type BarDay,
  type BarMode,
} from './barchart'

export interface BarSeries {
  key: string
  label: string
  /** A viz token: "--iu-viz-1" or "var(--iu-viz-gain)". */
  color: string
}

const props = withDefaults(
  defineProps<{
    days: BarDay[]
    series: BarSeries[]
    mode?: BarMode
    /** What the chart shows ("Lines changed per day"). Names the chart and captions the table. */
    label: string
    format?: (value: number) => string
    /** Axis tick labels; defaults to `format`. Lets the tooltip say "3 sessions" while the axis says "3". */
    tickFormat?: (value: number) => string
    height?: number
  }>(),
  { mode: 'grouped', format: undefined, tickFormat: undefined, height: 180 },
)

const GAP = 2
const PAD = { top: 8, right: 8, bottom: 22, left: 40 }

const root = ref<HTMLElement>()
const width = ref(480)
let ro: ResizeObserver | undefined
onMounted(() => {
  if (!root.value) return
  const w = root.value.clientWidth
  if (w > 0) width.value = w
  if (typeof ResizeObserver === 'undefined') return
  ro = new ResizeObserver(entries => {
    const cw = entries[0]?.contentRect.width ?? 0
    if (cw > 0) width.value = cw
  })
  ro.observe(root.value)
})
onBeforeUnmount(() => ro?.disconnect())

const text = (v: number) => (props.format ? props.format(v) : String(v))
const tick = (v: number) => (props.tickFormat ? props.tickFormat(v) : text(v))
const colour = (c: string) => (c.startsWith('--') ? `var(${c})` : c)
const visible = computed(() => props.series.slice(0, 2))
const n = computed(() => props.days.length)

const dom = computed(() => domain(props.days, props.mode))
const plotW = computed(() => Math.max(1, width.value - PAD.left - PAD.right))
const plotH = computed(() => Math.max(1, props.height - PAD.top - PAD.bottom))
const y = (v: number) =>
  PAD.top + ((dom.value[1] - v) / (dom.value[1] - dom.value[0])) * plotH.value
const baseline = computed(() => y(0))
const slot = computed(() => (n.value ? plotW.value / n.value : plotW.value))
const ticks = computed(() => niceTicks(dom.value[0], dom.value[1]))
const xTicks = computed(() =>
  dateTickIndices(n.value, Math.max(2, Math.floor(plotW.value / 70))).map(i => ({
    i,
    x: PAD.left + slot.value * i + slot.value / 2,
    label: shortDate(props.days[i]!.date),
  })),
)

const bars = computed(() => {
  const k = props.mode === 'diverging' ? 1 : visible.value.length
  const { w, offsets } = barSlot(slot.value, k, GAP)
  return props.days.map((d, di) => {
    const x0 = PAD.left + slot.value * di
    const paths = visible.value.map((s, si) => {
      const raw = d.values[si] ?? 0
      const diverge = props.mode === 'diverging'
      const value = diverge && si === 1 ? -Math.abs(raw) : raw
      const x = x0 + offsets[diverge ? 0 : si]!
      return { key: s.key, d: barPath(x, w, baseline.value, y(value)), color: colour(s.color) }
    })
    return { date: d.date, x0, paths }
  })
})

const summary = computed(() => {
  if (!n.value) return `${props.label}: no data`
  const totals = visible.value
    .map(
      (s, si) =>
        `${s.label} total ${text(props.days.reduce((a, d) => a + Math.abs(d.values[si] ?? 0), 0))}`,
    )
    .join(', ')
  return `${props.label}: ${n.value} days from ${props.days[0]!.date} to ${props.days[n.value - 1]!.date}. ${totals}.`
})

const active = ref<number | null>(null)
const focusable = ref(0)
const hits = ref<SVGRectElement[]>([])
const setHit = (el: unknown, i: number) => {
  if (el) hits.value[i] = el as SVGRectElement
}

function onKey(e: KeyboardEvent, i: number) {
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: n.value - 1 }[e.key]
  if (next === undefined) return
  e.preventDefault()
  const j = Math.max(0, Math.min(n.value - 1, next))
  focusable.value = j
  hits.value[j]?.focus()
}

const tip = computed(() => {
  const i = active.value
  if (i === null || !props.days[i]) return null
  const d = props.days[i]
  const left = PAD.left + slot.value * i + slot.value / 2
  return {
    date: d.date,
    rows: visible.value.map((s, si) => ({
      key: s.key,
      label: s.label,
      color: colour(s.color),
      value: text(Math.abs(d.values[si] ?? 0)),
    })),
    style: { left: `${Math.min(Math.max(left, 70), Math.max(70, width.value - 70))}px` },
  }
})
const uid = useId()
const dayLabel = (d: BarDay) =>
  `${d.date}: ${visible.value.map((s, si) => `${s.label} ${text(Math.abs(d.values[si] ?? 0))}`).join(', ')}`
</script>

<template>
  <figure ref="root" class="iu-barchart">
    <div v-if="visible.length >= 2" class="iu-barchart__legend">
      <span v-for="s in visible" :key="s.key" class="iu-barchart__key">
        <span class="iu-barchart__swatch" :style="{ background: colour(s.color) }" />
        {{ s.label }}
      </span>
    </div>
    <div class="iu-barchart__plot">
      <svg
        class="iu-barchart__svg"
        role="group"
        :aria-label="summary"
        :width="width"
        :height="height"
        :viewBox="`0 0 ${width} ${height}`"
      >
        <g aria-hidden="true">
          <g v-for="t in ticks" :key="t">
            <line
              class="iu-barchart__grid"
              :class="{ 'iu-barchart__grid--zero': t === 0 }"
              :x1="PAD.left"
              :x2="width - PAD.right"
              :y1="y(t)"
              :y2="y(t)"
            />
            <text
              class="iu-barchart__tick"
              :x="PAD.left - 6"
              :y="y(t)"
              text-anchor="end"
              dy="0.32em"
            >
              {{ tick(Math.abs(t)) }}
            </text>
          </g>
          <text
            v-for="t in xTicks"
            :key="t.i"
            class="iu-barchart__tick"
            :x="t.x"
            :y="height - 6"
            text-anchor="middle"
          >
            {{ t.label }}
          </text>
          <g
            v-for="b in bars"
            :key="b.date"
            :data-active="active === bars.indexOf(b) ? '' : undefined"
          >
            <path
              v-for="p in b.paths"
              :key="p.key"
              class="iu-barchart__bar"
              :d="p.d"
              :style="{ fill: p.color }"
            />
          </g>
        </g>
        <rect
          v-for="(d, i) in days"
          :key="`${uid}-${d.date}`"
          :ref="el => setHit(el, i)"
          class="iu-barchart__hit"
          role="img"
          :aria-label="dayLabel(d)"
          :tabindex="focusable === i ? 0 : -1"
          :x="PAD.left + slot * i"
          :y="PAD.top"
          :width="slot"
          :height="plotH"
          @pointerenter="active = i"
          @pointerleave="active = null"
          @focus="(active = i), (focusable = i)"
          @blur="active = null"
          @keydown="onKey($event, i)"
        />
      </svg>
      <div v-if="tip" class="iu-barchart__tip" :style="tip.style" aria-hidden="true">
        <p class="iu-barchart__tip-date">{{ tip.date }}</p>
        <p v-for="r in tip.rows" :key="r.key" class="iu-barchart__tip-row">
          <span class="iu-barchart__swatch" :style="{ background: r.color }" />
          {{ r.label }} <strong>{{ r.value }}</strong>
        </p>
      </div>
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
          <th v-for="s in visible" :key="s.key" scope="col">{{ s.label }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="d in days" :key="d.date">
          <th scope="row">{{ d.date }}</th>
          <td v-for="(s, si) in visible" :key="s.key">{{ text(Math.abs(d.values[si] ?? 0)) }}</td>
        </tr>
      </tbody>
    </table>
  </figure>
</template>

<style>
.iu-barchart {
  margin: 0;
  min-width: 0;
  width: 100%;
}
.iu-barchart__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  margin-bottom: 6px;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.iu-barchart__key,
.iu-barchart__tip-row {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.iu-barchart__swatch {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: var(--iu-radius-xs);
  flex: none;
}
.iu-barchart__plot {
  position: relative;
}
.iu-barchart__svg {
  display: block;
  max-width: 100%;
  overflow: visible;
}
.iu-barchart__grid {
  stroke: var(--iu-viz-grid);
  stroke-width: 1;
}
.iu-barchart__grid--zero {
  stroke: var(--iu-viz-zero-line);
}
.iu-barchart__tick {
  fill: var(--iu-viz-axis-label);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
}
.iu-barchart__bar {
  opacity: 0.9;
}
.iu-barchart__svg g[data-active] .iu-barchart__bar {
  opacity: 1;
}
.iu-barchart__hit {
  fill: transparent;
  outline: none;
}
.iu-barchart__hit:hover,
.iu-barchart__hit:focus-visible {
  fill: var(--iu-hairline);
  fill-opacity: 0.5;
}
.iu-barchart__hit:focus-visible {
  stroke: var(--iu-accent);
  stroke-width: 2;
}
.iu-barchart__tip {
  position: absolute;
  top: 0;
  transform: translate(-50%, -100%);
  pointer-events: none;
  z-index: 1;
  padding: 6px 10px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  background: var(--iu-surface-raised);
  box-shadow: var(--iu-shadow-raised);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text);
  white-space: nowrap;
  animation: iu-barchart-fade 0.12s ease-out;
}
.iu-barchart__tip p {
  margin: 0;
}
.iu-barchart__tip-date {
  color: var(--iu-text-muted);
}
.iu-barchart__tip strong {
  font-family: var(--iu-font-mono);
  font-weight: var(--iu-font-weight-medium);
  font-variant-numeric: tabular-nums;
}
@keyframes iu-barchart-fade {
  from {
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .iu-barchart__tip {
    animation: none;
  }
}
</style>
