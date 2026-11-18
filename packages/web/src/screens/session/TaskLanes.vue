<script setup lang="ts">
// The expanded Background tasks section: the project's branch graph for a run. The session is the trunk; every
// subagent and command forks onto its own lane and the branch is as long as it has worked (x = time). One status
// cell per row says the state, what it is doing and for how long. Lines are decoration: the words carry the facts.
import { computed } from 'vue'
import { placeTree, spanLabel, type TreeNode } from './taskTree'

const props = defineProps<{ nodes: TreeNode[]; now: number; hidden?: number; running?: boolean }>()
const emit = defineEmits<{ select: [id: string] }>()

const ROW = 28
const GRAPH = 96
const R = 7
const layout = computed(() =>
  placeTree(props.nodes, props.now, { width: GRAPH, row: ROW, min: 10, pad: 6 }),
)
const path = (p: (typeof layout.value.placed)[number]) =>
  `M${p.x0} ${p.fromY}V${p.y - R}Q${p.x0} ${p.y} ${p.x0 + R} ${p.y}H${p.x1}`
</script>

<template>
  <ul class="task-lanes" :style="{ '--row': ROW + 'px', '--graph': GRAPH + 'px' }">
    <li v-if="hidden" class="task-lanes__more">{{ hidden }} earlier not shown</li>
    <li class="task-lanes__row task-lanes__main">
      <span class="task-lanes__name">This session</span>
      <span class="task-lanes__state">
        <span class="task-lanes__word">{{ running ? 'Working' : 'Idle' }}</span>
      </span>
    </li>
    <li
      v-for="p in layout.placed"
      :key="p.node.id"
      class="task-lanes__row"
      :data-state="p.node.state"
    >
      <button
        type="button"
        class="session-side__open task-lanes__name"
        :style="{ paddingLeft: p.node.depth * 10 + 'px' }"
        :title="p.node.label"
        @click="emit('select', p.node.id)"
      >
        {{ p.node.label }}
      </button>
      <span class="task-lanes__state">
        <span class="task-lanes__word">{{ p.node.stateLabel }}</span>
        <span v-if="p.node.summary" class="task-lanes__note">{{ p.node.summary }}</span>
        <span class="task-lanes__time">{{ spanLabel(p.node, now) }}</span>
      </span>
    </li>
    <li class="task-lanes__graph" aria-hidden="true">
      <svg :width="GRAPH" :height="layout.height">
        <line :x1="6" :x2="layout.trunkEnd" :y1="ROW / 2" :y2="ROW / 2" class="task-lanes__trunk" />
        <circle :cx="layout.trunkEnd" :cy="ROW / 2" r="3.5" class="task-lanes__trunk-head" />
        <g
          v-for="p in layout.placed"
          :key="p.node.id"
          :data-state="p.node.state"
          :data-kind="p.node.kind"
        >
          <path :d="path(p)" class="task-lanes__line" />
          <g :transform="`translate(${p.x1} ${p.y})`">
            <template v-if="p.node.state === 'running'">
              <circle r="7" class="task-lanes__halo" />
              <rect
                v-if="p.node.kind === 'command'"
                x="-3"
                y="-3"
                width="6"
                height="6"
                rx="1.2"
                class="task-lanes__head"
              />
              <circle v-else r="3.5" class="task-lanes__head" />
            </template>
            <circle v-else-if="p.node.state === 'done'" r="3.8" class="task-lanes__merge" />
            <path
              v-else-if="p.node.state === 'failed'"
              d="M-3.5 -3.5l7 7m0 -7l-7 7"
              class="task-lanes__cross"
            />
            <path v-else d="M-3.5 0h7" class="task-lanes__cross" />
          </g>
        </g>
      </svg>
    </li>
  </ul>
</template>

<style>
.task-lanes {
  position: relative;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
  --ink: var(--iu-text-muted);
}
.task-lanes__row {
  display: grid;
  grid-template-columns: 124px calc(var(--graph) + 16px) minmax(0, 1fr);
  align-items: center;
  height: var(--row);
  font-size: var(--iu-font-size-12);
}
.task-lanes__row > .task-lanes__name {
  grid-column: 1;
}
.task-lanes__row > .task-lanes__state {
  grid-column: 3;
}
.task-lanes__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  color: var(--iu-text);
  box-sizing: border-box;
}
.task-lanes__main .task-lanes__name {
  color: var(--iu-text-2);
}
.task-lanes__state {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
  color: var(--iu-text-muted);
}
.task-lanes__word::first-letter {
  text-transform: uppercase;
}
.task-lanes__word {
  flex: none;
  min-width: 52px;
  color: var(--ink);
}
.task-lanes__note {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.task-lanes__time {
  flex: none;
  margin-left: auto;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11, 11px);
}
.task-lanes__more {
  height: 20px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11, 11px);
}
.task-lanes__graph {
  position: absolute;
  left: 128px;
  bottom: 0;
  overflow: visible;
  pointer-events: none;
}
.task-lanes [data-state='running'] {
  --ink: var(--iu-info);
}
.task-lanes [data-state='done'] {
  --ink: var(--iu-positive);
}
.task-lanes [data-state='failed'] {
  --ink: var(--iu-danger);
}
.task-lanes__trunk {
  stroke: var(--iu-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
}
.task-lanes__trunk-head {
  fill: var(--iu-text);
}
.task-lanes__line {
  fill: none;
  stroke: var(--ink);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
[data-kind='command'] > .task-lanes__line {
  stroke-dasharray: 4 3;
}
[data-state='done'] > .task-lanes__line {
  opacity: 0.7;
}
.task-lanes__head {
  fill: var(--ink);
}
.task-lanes__halo {
  fill: var(--ink);
  opacity: 0.2;
}
.task-lanes__merge {
  fill: var(--iu-surface, var(--iu-ground));
  stroke: var(--ink);
  stroke-width: 2;
}
.task-lanes__cross {
  fill: none;
  stroke: var(--ink);
  stroke-width: 2;
  stroke-linecap: round;
}
@media (prefers-reduced-motion: no-preference) {
  .task-lanes__halo {
    animation: task-lanes-pulse 1.8s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }
}
@keyframes task-lanes-pulse {
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
