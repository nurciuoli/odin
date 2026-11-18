<script setup lang="ts">
// Variation 4, strip: the smallest version, for a session header or the sidebar. 7px lanes, no labels, so the shape
// of the run reads at a glance. Only branches that need you (waiting or failed) get a label at their tip; the rest
// stays quiet. Counts in words sit underneath.
import { computed } from 'vue'
import { nodesAt, rowCount, stateColor, stateWord, summary } from './tree'

const props = defineProps<{ t: number }>()
const PITCH = 8
const X0 = 6
const PX = 17
const nodes = computed(() => nodesAt(props.t))
const y = (row: number) => (row + 1) * PITCH + 4
const geo = computed(() =>
  nodes.value
    .filter((n) => n.state !== 'pending')
    .map((n) => {
      const parent = n.parent === 'main' ? null : nodes.value.find((x) => x.id === n.parent)!
      const py = parent ? y(parent.row) : 4
      const sx = X0 + n.start * PX
      const ey = y(n.row)
      const ex = Math.max(sx + 6, sx + n.len * PX)
      return { n, d: `M${sx} ${py}V${ey - 3}Q${sx} ${ey} ${sx + 3} ${ey}H${ex}`, ex, ey, color: stateColor[n.state] }
    }),
)
const trunkEnd = computed(() => X0 + props.t * PX)
const counts = computed(() => (['running', 'waiting', 'done', 'failed'] as const).map((s) => ({ s, n: nodes.value.filter((x) => x.state === s).length })))
</script>

<template>
  <div class="strip">
    <svg :viewBox="`0 0 820 ${rowCount * PITCH + 8}`" :height="rowCount * PITCH + 8" role="img" :aria-label="summary(nodes)">
      <line :x1="X0" :x2="trunkEnd" y1="4" y2="4" class="trunk" />
      <circle :cx="trunkEnd" cy="4" r="3" class="maindot" />
      <g v-for="g in geo" :key="g.n.id">
        <path :d="g.d" class="line" :class="[g.n.kind, g.n.state]" :style="{ stroke: g.color }" />
        <circle :cx="g.ex" :cy="g.ey" :r="g.n.state === 'running' ? 3 : 2.6" :class="['tip', g.n.state]" :style="g.n.state === 'waiting' ? { stroke: g.color } : { fill: g.color }" />
        <text v-if="(g.n.state === 'waiting' || g.n.state === 'failed') && !(g.n.kind === 'process' && nodes.find((m) => m.id === g.n.parent)!.state === 'failed')" :x="g.ex + 10" :y="g.ey + 3.5" class="label">
          {{ g.n.name }} <tspan :style="{ fill: g.color }">{{ stateWord[g.n.state] }}</tspan><tspan class="muted"> · {{ g.n.note }}</tspan>
        </text>
      </g>
    </svg>
    <p class="counts">
      <span v-for="c in counts" :key="c.s" class="count"><i :style="{ background: c.s === 'waiting' ? 'transparent' : stateColor[c.s], borderColor: stateColor[c.s] }" />{{ c.n }} {{ c.s === 'done' ? 'returned' : c.s === 'waiting' ? 'waiting on you' : c.s === 'running' ? 'working' : 'failed' }}</span>
    </p>
  </div>
</template>

<style scoped>
.strip {
  font-family: var(--iu-font-sans);
}
svg {
  display: block;
  width: 100%;
}
.trunk {
  stroke: var(--iu-text-muted);
  stroke-width: 2.5;
  stroke-linecap: round;
}
.maindot {
  fill: var(--iu-text);
}
.line {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}
.line.process {
  stroke-dasharray: 3 2;
}
.line.done {
  opacity: 0.55;
}
.tip.waiting {
  fill: var(--iu-ground);
  stroke-width: 1.6;
}
.label {
  fill: var(--iu-text);
  font-size: 11px;
}
.muted {
  fill: var(--iu-text-muted);
}
.counts {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--iu-text-2);
}
.count {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.count i {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 1.5px solid;
}
</style>
