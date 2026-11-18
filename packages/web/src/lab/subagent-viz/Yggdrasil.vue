<script setup lang="ts">
// Variation B: Yggdrasil. The session is the trunk; every subagent is a branch that grows as it works. A bud rides
// the growing tip, holds still and hollow while it waits on the person, opens into a leaf when the work returns, and
// the branch withers and snaps when it fails.
import { computed } from 'vue'
import { stateColor, stateWord, type Sub } from './mock'

const props = defineProps<{ agents: Sub[] }>()
const TRUNK = 380

function point(p0: [number, number], c: [number, number], p1: [number, number], t: number): [number, number] {
  const u = 1 - t
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]
}

const branches = computed(() =>
  props.agents.map((a, i) => {
    const side = i % 2 === 0 ? 1 : -1
    const y = 262 - i * 44
    const start: [number, number] = [TRUNK, y]
    const ctrl: [number, number] = [TRUNK + side * 130, y + 4]
    const end: [number, number] = [TRUNK + side * 236, y - 34]
    const d = `M${start[0]} ${start[1]}Q${ctrl[0]} ${ctrl[1]} ${end[0]} ${end[1]}`
    const grown = a.state === 'pending' ? 0 : a.progress
    const tip = point(start, ctrl, end, grown)
    return { a, side, d, end, tip, grown, color: stateColor[a.state] }
  }),
)
</script>

<template>
  <svg class="ygg" viewBox="0 0 760 330" role="img" aria-label="Subagents as branches growing from the world tree">
    <!-- roots and trunk -->
    <path d="M370 316C356 306 330 304 296 312 M392 316C406 306 432 304 466 312 M376 320C366 322 350 326 330 328 M388 320C398 322 414 326 434 328" class="root" />
    <path d="M366 322C372 280 374 200 372 120C371 90 376 66 380 54C384 66 389 90 388 120C386 200 388 280 394 322Z" class="bole" />
    <path d="M380 54C370 40 362 30 350 24 M380 54C390 40 398 30 410 24 M380 54V18" class="trunk crown" />
    <g v-for="b in branches" :key="b.a.id">
      <!-- the full length it could grow, faint -->
      <path :d="b.d" class="plan" />
      <!-- the grown part -->
      <path
        :d="b.d"
        pathLength="1"
        :stroke-dasharray="`${b.grown} 1.01`"
        class="grown"
        :class="b.a.state"
        :style="b.a.state === 'failed' ? { stroke: b.color } : {}"
      />
      <!-- the tip -->
      <g v-if="b.a.state !== 'pending'" :transform="`translate(${b.tip[0]} ${b.tip[1]})`">
        <circle v-if="b.a.state === 'running'" r="9" class="halo" :style="{ fill: b.color }" />
        <circle v-if="b.a.state === 'running'" r="4.5" :style="{ fill: b.color }" />
        <circle v-if="b.a.state === 'waiting'" r="5.5" class="hollow" :style="{ stroke: b.color }" />
        <path
          v-if="b.a.state === 'done'"
          :transform="`rotate(${b.side > 0 ? -25 : 205})`"
          d="M0 0C4 -10 16 -12 22 -8C18 0 8 6 0 0Z"
          class="leaf"
          :style="{ fill: b.color }"
        />
        <g v-if="b.a.state === 'failed'" :style="{ stroke: b.color }" class="snap">
          <path d="M-5 -5l10 10 M5 -5l-10 10" />
        </g>
      </g>
      <!-- the label stays where the branch will end -->
      <g :transform="`translate(${b.end[0] + b.side * 34} ${b.end[1] - 8})`">
        <text :text-anchor="b.side > 0 ? 'start' : 'end'" class="name">
          {{ b.a.name }}
        </text>
        <text :text-anchor="b.side > 0 ? 'start' : 'end'" y="14" class="state" :style="{ fill: b.a.state === 'pending' ? undefined : b.color }">
          {{ stateWord[b.a.state] }}
        </text>
        <text :text-anchor="b.side > 0 ? 'start' : 'end'" y="27" class="note">{{ b.a.note }}</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.ygg {
  display: block;
  width: 100%;
  font-family: var(--iu-font-sans);
}
.bole {
  fill: var(--iu-border-strong);
  opacity: 0.8;
}
.trunk,
.root {
  fill: none;
  stroke: var(--iu-border-strong);
  stroke-linecap: round;
}
.trunk {
  stroke-width: 6;
}
.crown {
  stroke-width: 5;
}
.root {
  stroke-width: 4;
}
.plan {
  fill: none;
  stroke: var(--iu-border);
  stroke-width: 1.5;
  stroke-dasharray: 2 5;
}
.grown {
  fill: none;
  stroke: var(--iu-text-muted);
  stroke-width: 4;
  stroke-linecap: round;
}
.grown.done {
  stroke: var(--iu-text-2);
}
.grown.failed {
  stroke-dasharray: 3 3 !important;
  stroke-width: 2.5;
}
.halo {
  opacity: 0.22;
}
.hollow {
  fill: var(--iu-ground);
  stroke-width: 2;
}
.leaf {
  opacity: 0.9;
}
.snap {
  stroke-width: 2;
  stroke-linecap: round;
}
.name {
  fill: var(--iu-text);
  font-size: 13px;
  font-weight: 500;
}
.state {
  fill: var(--iu-text-muted);
  font-size: 11px;
}
.note {
  fill: var(--iu-text-muted);
  font-size: 11px;
}
@media (prefers-reduced-motion: no-preference) {
  .halo {
    animation: pulse 1.8s ease-in-out infinite;
    transform-box: fill-box;
    transform-origin: center;
  }
  .leaf {
    animation: unfurl 0.7s ease-out;
    transform-box: fill-box;
    transform-origin: left center;
  }
}
@keyframes pulse {
  0%,
  100% {
    transform: scale(0.8);
    opacity: 0.12;
  }
  50% {
    transform: scale(1.35);
    opacity: 0.3;
  }
}
@keyframes unfurl {
  from {
    transform: scale(0.2);
  }
}
</style>
