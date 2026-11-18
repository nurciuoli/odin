<script setup lang="ts">
// Variation 3, log: `git log --graph` for a run. One row per subagent or process, a gutter of lanes on the left,
// text on the right. A branch lengthens down the gutter as later rows start while it is still going, and curves back
// into its parent when it returns. The bar on the right is the exact time spent. 22px rows.
import { computed } from 'vue'
import { elapsed, nodesAt, rowCount, stateColor, stateWord, SECONDS_SHOWN } from './tree'

const props = defineProps<{ t: number }>()
const ROW = 22
const LANE = 14
const nodes = computed(() => nodesAt(props.t))
const y = (row: number) => (row + 1) * ROW + ROW / 2
const lx = (lane: number) => lane * LANE + 9
const gutter = computed(() => (Math.max(...nodes.value.map((n) => n.lane)) + 1) * LANE + 10)
const bottom = computed(() => Math.max(0, ...nodes.value.filter((n) => n.state !== 'pending').map((n) => n.row)))
const geo = computed(() =>
  nodes.value
    .filter((n) => n.state !== 'pending')
    .map((n) => {
      const parent = n.parent === 'main' ? null : nodes.value.find((x) => x.id === n.parent)!
      const px = lx(parent ? parent.lane : 0)
      const x = lx(n.lane)
      const ey = y(n.row)
      const over = n.state === 'running' || n.state === 'waiting'
      const cut = over ? props.t : n.start + n.len
      const last = Math.max(n.row, ...nodes.value.filter((m) => m.state !== 'pending' && m.start <= cut).map((m) => m.row))
      const endY = y(last)
      return {
        n,
        x,
        ey,
        endY,
        fork: `M${px} ${ey - ROW}C${px} ${ey - 6} ${x} ${ey - ROW + 6} ${x} ${ey}`,
        merge: `M${x} ${endY}C${x} ${endY + 6} ${px} ${endY + ROW - 6} ${px} ${endY + ROW}`,
        color: stateColor[n.state],
      }
    }),
)
</script>

<template>
  <div class="log" :style="{ '--row': ROW + 'px', '--gutter': gutter + 'px' }">
    <svg class="gutter" :width="gutter" :height="rowCount * ROW" aria-hidden="true">
      <line :x1="lx(0)" :x2="lx(0)" :y1="ROW / 2" :y2="y(bottom) + ROW" class="trunk" />
      <circle :cx="lx(0)" :cy="ROW / 2" r="4.5" class="maindot" />
      <g v-for="g in geo" :key="g.n.id">
        <path :d="g.fork" class="line" :style="{ stroke: g.color }" />
        <line :x1="g.x" :x2="g.x" :y1="g.ey" :y2="g.endY" class="line" :class="[g.n.kind, g.n.state]" :style="{ stroke: g.color }" />
        <circle :cx="g.x" :cy="g.ey" r="3" class="forkdot" :style="{ fill: g.color }" />
        <g :transform="`translate(${g.x} ${g.endY})`">
          <template v-if="g.n.state === 'running'">
            <circle r="7" class="halo" :style="{ fill: g.color }" />
            <rect v-if="g.n.kind === 'process'" x="-3" y="-3" width="6" height="6" rx="1.2" :style="{ fill: g.color }" />
            <circle v-else r="3.5" :style="{ fill: g.color }" />
          </template>
          <circle v-else-if="g.n.state === 'waiting'" r="4" class="ring" :style="{ stroke: g.color }" />
          <path v-else-if="g.n.state === 'failed'" d="M-3.5 -3.5l7 7m0 -7l-7 7" class="cross" :style="{ stroke: g.color }" />
        </g>
        <circle v-if="g.n.state === 'done'" :cx="g.x" :cy="g.endY" r="4" class="mergedot" :style="{ stroke: g.color }" />
      </g>
    </svg>
    <ul>
      <li class="main"><span class="name">main</span><span class="tag">session</span></li>
      <li v-for="n in nodes" :key="n.id" :class="{ off: n.state === 'pending' }">
        <template v-if="n.state !== 'pending'">
          <span class="name">{{ n.name }}</span>
          <span class="tag">{{ n.kind === 'process' ? 'process' : '' }}</span>
          <span class="word" :style="{ color: stateColor[n.state] }">{{ stateWord[n.state] }}</span>
          <span class="note">{{ n.note }}</span>
          <span class="bar"><i :style="{ width: Math.min(100, (n.len / SECONDS_SHOWN) * 100) + '%', background: stateColor[n.state] }" /></span>
          <span class="time">{{ elapsed(n) }}</span>
        </template>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.log {
  position: relative;
  font-size: 12px;
  color: var(--iu-text-2);
}
.gutter {
  position: absolute;
  left: 0;
  top: 0;
  overflow: visible;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0 0 0 calc(var(--gutter) + 6px);
}
li {
  height: var(--row);
  display: grid;
  grid-template-columns: 100px 52px 100px minmax(0, 1fr) 80px 32px;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
li.main {
  grid-template-columns: 100px auto;
}
.off {
  visibility: hidden;
}
.name {
  font-family: var(--iu-font-mono);
  color: var(--iu-text);
  overflow: hidden;
  text-overflow: ellipsis;
}
.tag:empty {
  visibility: hidden;
}
.tag {
  font-size: 10px;
  color: var(--iu-text-muted);
  border: 1px solid var(--iu-border);
  border-radius: 4px;
  padding: 0 4px;
  line-height: 14px;
  justify-self: start;
}
.note {
  color: var(--iu-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  height: 4px;
  border-radius: 2px;
  background: var(--iu-hairline);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  opacity: 0.8;
}
.time {
  text-align: right;
  font-family: var(--iu-font-mono);
  font-size: 11px;
  color: var(--iu-text-muted);
}
.trunk {
  stroke: var(--iu-text-muted);
  stroke-width: 2;
}
.maindot {
  fill: var(--iu-text);
}
.line {
  fill: none;
  stroke-width: 2;
  stroke-linecap: round;
}
.line.faint {
  opacity: 0.45;
  stroke-width: 1.5;
}
.line.process {
  stroke-dasharray: 4 3;
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
