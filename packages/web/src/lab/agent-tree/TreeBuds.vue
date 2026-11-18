<script setup lang="ts">
// Variation 2, buds: the Yggdrasil version of the same graph. Branches are soft curves, labels ride the growing tip
// so there are no columns at all, and the tips are plants: a bud while working, a hollow bud while waiting, a leaf
// when the work has returned, a snapped twig when it fails. 22px rows.
import { computed } from 'vue'
import { nodesAt, rowCount, stateColor, stateWord } from './tree'

const props = defineProps<{ t: number }>()
const ROW = 22
const X0 = 8
const PX = 12
const nodes = computed(() => nodesAt(props.t))
const y = (row: number) => (row + 1) * ROW + ROW / 2
const geo = computed(() =>
  nodes.value
    .filter((n) => n.state !== 'pending')
    .map((n) => {
      const parent = n.parent === 'main' ? null : nodes.value.find((x) => x.id === n.parent)!
      const py = parent ? y(parent.row) : ROW / 2
      const sx = X0 + n.start * PX
      const ey = y(n.row)
      const ex = Math.max(sx + 16, sx + n.len * PX)
      // a swept curve out of the parent, then level
      const d = `M${sx} ${py}C${sx + 2} ${ey - 6} ${sx + 6} ${ey} ${sx + 16} ${ey}H${ex}`
      return { n, d, ex, ey, color: stateColor[n.state] }
    }),
)
const trunkEnd = computed(() => X0 + props.t * PX)
</script>

<template>
  <svg class="buds" :viewBox="`0 0 820 ${rowCount * ROW}`" :height="rowCount * ROW" role="img" aria-label="Subagents and processes as branches of the session">
    <path :d="`M${X0} ${ROW / 2}H${trunkEnd}`" class="trunk" />
    <text :x="trunkEnd + 10" :y="ROW / 2 + 4" class="name">main</text>
    <g v-for="g in geo" :key="g.n.id">
      <path :d="g.d" class="twig" :class="[g.n.kind, g.n.state]" :style="g.n.state === 'failed' ? { stroke: g.color } : {}" />
      <g :transform="`translate(${g.ex} ${g.ey})`">
        <template v-if="g.n.state === 'running'">
          <circle r="8" class="halo" :style="{ fill: g.color }" />
          <path d="M0 0C3 -9 13 -9 16 -5C12 2 4 4 0 0Z" :style="{ fill: g.color }" transform="translate(-4 0)" />
        </template>
        <circle v-else-if="g.n.state === 'waiting'" r="4.5" class="hollow" :style="{ stroke: g.color }" />
        <path v-else-if="g.n.state === 'done'" d="M0 0C3 -9 14 -10 18 -5C14 3 5 6 0 0Z" class="leaf" :style="{ fill: g.color }" />
        <path v-else d="M-4 -4l8 8m0 -8l-8 8" class="snap" :style="{ stroke: g.color }" />
      </g>
      <text :x="g.ex + (g.n.state === 'done' ? 26 : 16)" :y="g.ey + 4" class="name">
        {{ g.n.name }}
        <tspan class="meta" :style="{ fill: g.color }"> · {{ stateWord[g.n.state] }}</tspan>
        <tspan class="meta"> · {{ g.n.note }}</tspan>
      </text>
    </g>
  </svg>
</template>

<style scoped>
.buds {
  display: block;
  width: 100%;
  font-family: var(--iu-font-sans);
}
.trunk {
  fill: none;
  stroke: var(--iu-text-muted);
  stroke-width: 3;
  stroke-linecap: round;
}
.twig {
  fill: none;
  stroke: var(--iu-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
}
.twig.process {
  stroke-dasharray: 1 4;
  stroke-width: 2.6;
}
.twig.done {
  stroke: var(--iu-text-2);
}
.twig.failed {
  stroke-dasharray: 4 3;
}
.name {
  fill: var(--iu-text);
  font-size: 12px;
  paint-order: stroke;
  stroke: var(--iu-ground);
  stroke-width: 5px;
  stroke-linejoin: round;
}
.meta {
  fill: var(--iu-text-muted);
  font-size: 11px;
}
.halo {
  opacity: 0.2;
}
.hollow {
  fill: var(--iu-ground);
  stroke-width: 2;
}
.leaf {
  opacity: 0.9;
}
.snap {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}
@media (prefers-reduced-motion: no-preference) {
  .halo {
    animation: pulse 1.8s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }
}
@keyframes pulse {
  0%,
  100% {
    transform: scale(0.7);
    opacity: 0.1;
  }
  50% {
    transform: scale(1.3);
    opacity: 0.28;
  }
}
</style>
