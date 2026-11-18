<script setup lang="ts">
// Variation 1, lanes: the project git graph, for a run. The trunk is the session; every subagent and process forks
// onto its own lane and the branch lengthens for as long as it works (x = time). A finished branch merges back into
// what spawned it. Names on the left, state in words on the right, 24px rows.
import { computed } from 'vue'
import { elapsed, nodesAt, rowCount, stateColor, stateWord, type TreeNode } from './tree'

const props = defineProps<{ t: number }>()
const ROW = 24
const X0 = 10
const PX = 9
const R = 8
const nodes = computed(() => nodesAt(props.t))
const y = (row: number) => (row + 1) * ROW + ROW / 2
const width = X0 + 34 * PX + 24
const geo = computed(() =>
  nodes.value
    .filter((n) => n.state !== 'pending')
    .map((n) => {
      const parent = n.parent === 'main' ? null : nodes.value.find((x) => x.id === n.parent)!
      const py = parent ? y(parent.row) : ROW / 2
      const sx = X0 + n.start * PX
      const ey = y(n.row)
      const ex = Math.max(sx + R + 2, sx + n.len * PX)
      const mx = ex + 10
      const line = `M${sx} ${py}V${ey - R}Q${sx} ${ey} ${sx + R} ${ey}H${ex}`
      const merge = ''
      return { n, line, merge, sx, ex, mx, ey, py, color: stateColor[n.state] }
    }),
)
const trunkEnd = computed(() => X0 + props.t * PX)
const tag = (n: TreeNode) => (n.kind === 'process' ? 'process' : '')
</script>

<template>
  <div class="lanes" :style="{ '--row': ROW + 'px' }">
    <ul class="names">
      <li class="trunk">main <span class="tag">session</span></li>
      <li v-for="n in nodes" :key="n.id" :class="{ off: n.state === 'pending' }" :style="{ paddingLeft: (n.depth - 1) * 12 + 'px' }">
        {{ n.name }} <span v-if="tag(n)" class="tag">{{ tag(n) }}</span>
      </li>
    </ul>
    <div class="scroll">
      <svg :width="width" :height="rowCount * ROW" aria-hidden="true">
        <line :x1="X0" :x2="trunkEnd" :y1="ROW / 2" :y2="ROW / 2" class="trunkline" />
        <circle :cx="trunkEnd" :cy="ROW / 2" r="4" class="head run" />
        <g v-for="g in geo" :key="g.n.id">
          <path v-if="g.merge" :d="g.merge" class="merge" :style="{ stroke: g.color }" />
          <path :d="g.line" class="branch" :class="[g.n.kind, g.n.state]" :style="{ stroke: g.color }" />
          <circle v-if="g.n.state === 'done'" :cx="g.ex" :cy="g.ey" r="4" class="mergedot" :style="{ stroke: g.color }" />
          <g v-if="g.n.state === 'running'" :transform="`translate(${g.ex} ${g.ey})`">
            <circle r="8" class="halo" :style="{ fill: g.color }" />
            <rect v-if="g.n.kind === 'process'" x="-3.5" y="-3.5" width="7" height="7" rx="1.5" :style="{ fill: g.color }" />
            <circle v-else r="4" :style="{ fill: g.color }" />
          </g>
          <circle v-else-if="g.n.state === 'waiting'" :cx="g.ex" :cy="g.ey" r="4.5" class="ring" :style="{ stroke: g.color }" />
          <path v-else-if="g.n.state === 'failed'" :d="`M${g.ex - 4} ${g.ey - 4}l8 8m0 -8l-8 8`" class="cross" :style="{ stroke: g.color }" />
        </g>
      </svg>
    </div>
    <ul class="states">
      <li class="trunk">{{ nodes.some((n) => n.state === 'waiting') ? 'Needs you' : 'Working' }}</li>
      <li v-for="n in nodes" :key="n.id" :class="{ off: n.state === 'pending' }">
        <template v-if="n.state !== 'pending'">
          <span class="word" :style="{ color: stateColor[n.state] }">{{ stateWord[n.state] }}</span>
          <span class="note">{{ n.note }}</span>
          <span class="time">{{ elapsed(n) }}</span>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.lanes {
  display: grid;
  grid-template-columns: 178px auto minmax(0, 1fr);
  gap: 8px;
  font-size: 12px;
  color: var(--iu-text-2);
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
li {
  height: var(--row);
  line-height: var(--row);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.names li {
  font-family: var(--iu-font-mono);
}
.trunk {
  color: var(--iu-text);
}
.tag {
  font-family: var(--iu-font-sans);
  font-size: 10px;
  color: var(--iu-text-muted);
  border: 1px solid var(--iu-border);
  border-radius: 4px;
  padding: 0 4px;
  margin-left: 4px;
}
.off {
  visibility: hidden;
}
.states li {
  display: grid;
  grid-template-columns: 96px 1fr 30px;
  gap: 6px;
}
.note {
  color: var(--iu-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.time {
  text-align: right;
  color: var(--iu-text-muted);
  font-family: var(--iu-font-mono);
  font-size: 11px;
}
.scroll {
  overflow-x: auto;
}
svg {
  display: block;
  overflow: visible;
}
.trunkline {
  stroke: var(--iu-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
}
.head.run {
  fill: var(--iu-text);
}
.branch,
.merge {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.branch.process {
  stroke-dasharray: 5 3;
}
.branch.done {
  opacity: 0.7;
}
.merge {
  opacity: 0.45;
  stroke-width: 1.5;
}
.mergedot {
  fill: var(--iu-surface);
  stroke-width: 2;
}
.ring {
  fill: var(--iu-ground);
  stroke-width: 2;
}
.cross {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}
.halo {
  opacity: 0.2;
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
