<script setup lang="ts">
// The collapsed Background tasks section: the same branches at 6px a lane, no text, so the shape of the run reads at
// a glance. The summary line above it carries the counts in words.
import { computed } from 'vue'
import { placeTree, type TreeNode } from './taskTree'

const props = defineProps<{ nodes: TreeNode[]; now: number }>()
const ROW = 6
const WIDTH = 360
const layout = computed(() =>
  placeTree(props.nodes, props.now, { width: WIDTH, row: ROW, min: 4, pad: 4 }),
)
const path = (p: (typeof layout.value.placed)[number]) =>
  `M${p.x0} ${p.fromY}V${p.y - 3}Q${p.x0} ${p.y} ${p.x0 + 3} ${p.y}H${p.x1}`
</script>

<template>
  <svg
    class="task-strip"
    :viewBox="`0 0 ${WIDTH} ${layout.height}`"
    :height="layout.height"
    aria-hidden="true"
  >
    <line x1="4" :x2="layout.trunkEnd" :y1="ROW / 2" :y2="ROW / 2" class="task-strip__trunk" />
    <circle :cx="layout.trunkEnd" :cy="ROW / 2" r="2.5" class="task-strip__trunk-head" />
    <g
      v-for="p in layout.placed"
      :key="p.node.id"
      :data-state="p.node.state"
      :data-kind="p.node.kind"
    >
      <path :d="path(p)" class="task-strip__line" />
      <circle :cx="p.x1" :cy="p.y" r="2.4" class="task-strip__head" />
    </g>
  </svg>
</template>

<style>
.task-strip {
  display: block;
  width: 100%;
  overflow: visible;
  --ink: var(--iu-text-muted);
}
.task-strip [data-state='running'] {
  --ink: var(--iu-info);
}
.task-strip [data-state='done'] {
  --ink: var(--iu-positive);
}
.task-strip [data-state='failed'] {
  --ink: var(--iu-danger);
}
.task-strip__trunk {
  stroke: var(--iu-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
}
.task-strip__trunk-head {
  fill: var(--iu-text);
}
.task-strip__line {
  fill: none;
  stroke: var(--ink);
  stroke-width: 1.6;
  stroke-linecap: round;
}
[data-kind='command'] > .task-strip__line {
  stroke-dasharray: 3 2;
}
[data-state='done'] > .task-strip__line {
  opacity: 0.6;
}
.task-strip__head {
  fill: var(--ink);
}
</style>
