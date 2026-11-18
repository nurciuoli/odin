<script setup lang="ts">
// Variation A: Huginn and Muninn. Each subagent is a raven sent out from Odin's high seat. It flies along its lane
// toward the rune stone that is the task, waits on a wire when it needs the person, lands back on the seat with
// the result, or falls with a broken feather when it fails.
import { computed } from 'vue'
import { stateColor, stateWord, type Sub } from './mock'

const props = defineProps<{ agents: Sub[] }>()
const HOME = 196
const FAR = 548
const lanes = computed(() =>
  props.agents.map((a, i) => {
    const y = 58 + i * 46
    const x = a.state === 'done' || a.state === 'pending' ? HOME : HOME + Math.min(a.progress, a.state === 'failed' ? 0.86 : 1) * (FAR - HOME)
    const bob = a.state === 'running' ? Math.sin(a.progress * 22) * 5 : 0
    return { a, y, x, bob, color: stateColor[a.state] }
  }),
)
</script>

<template>
  <svg class="ravens" viewBox="0 0 760 300" role="img" aria-label="Subagents as ravens flying out from Odin's high seat">
    <text x="14" y="22" class="head">Subagent</text>
    <text x="580" y="22" class="head">State</text>
    <text :x="HOME" y="22" class="head" text-anchor="middle">High seat</text>
    <text :x="FAR" y="22" class="head" text-anchor="middle">Task</text>
    <!-- Hlidskjalf: the seat the ravens leave from and come back to -->
    <path :d="`M${HOME - 10} 38V290`" class="post" />
    <g v-for="l in lanes" :key="l.a.id">
      <line :x1="HOME - 10" :x2="FAR + 22" :y1="l.y" :y2="l.y" class="lane" />
      <!-- trail: how far it has flown -->
      <line
        v-if="l.a.state !== 'pending'"
        :x1="HOME"
        :x2="l.x"
        :y1="l.y"
        :y2="l.y + l.bob"
        class="trail"
        :class="{ dash: l.a.state === 'failed' }"
        :style="{ stroke: l.color }"
      />
      <!-- the stone each raven flies to -->
      <g :transform="`translate(${FAR + 14} ${l.y})`">
        <circle r="11" class="stone" :style="l.a.state === 'done' ? { stroke: l.color } : {}" />
        <path d="M-3 7V-7L3 -3L-3 1L3 7" class="stone-rune" :style="l.a.state === 'done' ? { stroke: l.color } : {}" />
      </g>
      <!-- the raven -->
      <g
        :transform="`translate(${l.x} ${l.y + l.bob}) scale(1.2) ${l.a.state === 'failed' ? 'rotate(72)' : ''}`"
        :opacity="l.a.state === 'pending' ? 0.35 : 1"
      >
        <g v-if="l.a.state === 'waiting'" transform="translate(0 12)">
          <line x1="-16" x2="16" class="wire" :style="{ stroke: l.color }" />
        </g>
        <g :class="['bird', l.a.state]" :transform="l.a.state === 'waiting' || l.a.state === 'done' || l.a.state === 'pending' ? 'translate(0 3)' : ''">
          <path class="wing" d="M-4 -4C-8 -18 4 -22 14 -19C9 -12 7 -6 5 -2Z" />
          <path class="body" d="M-16 4L-25 9L-17 1C-14 -5 -4 -8 6 -6C9 -9 14 -9 16 -6L25 -3L16 -1C14 3 8 6 0 6C-6 6 -12 6 -16 4Z" />
          <circle cx="12" cy="-5" r="1.5" class="eye" :style="{ fill: l.color }" />
        </g>
        <path v-if="l.a.state === 'failed'" d="M-22 -6l8 6" class="feather" style="stroke: var(--iu-danger)" />
      </g>
      <!-- labels -->
      <text x="14" :y="l.y - 2" class="name">{{ l.a.name }}</text>
      <text x="14" :y="l.y + 12" class="task">{{ l.a.task }}</text>
      <g :transform="`translate(580 ${l.y - 2})`">
        <circle cx="4" cy="-4" r="4" :style="{ fill: l.a.state === 'waiting' ? 'none' : l.color, stroke: l.color }" class="dot" />
        <text x="16" y="0" class="state">{{ stateWord[l.a.state] }}</text>
        <text x="16" y="14" class="note">{{ l.a.note }}</text>
      </g>
    </g>
  </svg>
</template>

<style scoped>
.ravens {
  display: block;
  width: 100%;
  font-family: var(--iu-font-sans);
}
.head {
  fill: var(--iu-text-muted);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.post {
  stroke: var(--iu-border-strong);
  stroke-width: 2;
}
.lane {
  stroke: var(--iu-hairline);
  stroke-dasharray: 2 5;
}
.trail {
  stroke-width: 1.5;
  opacity: 0.55;
}
.trail.dash {
  stroke-dasharray: 3 4;
}
.stone {
  fill: var(--iu-surface);
  stroke: var(--iu-border);
}
.stone-rune {
  fill: none;
  stroke: var(--iu-text-muted);
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.wire {
  stroke-width: 2;
  stroke-linecap: round;
}
.body {
  fill: var(--iu-text-2);
}
.wing {
  fill: var(--iu-text-muted);
  transform-origin: 0 0;
}
.failed .body,
.failed .wing {
  fill: var(--iu-text-muted);
}
.feather {
  stroke-width: 1.5;
  fill: none;
  stroke-linecap: round;
}
.name {
  fill: var(--iu-text);
  font-size: 13px;
  font-weight: 500;
}
.task {
  fill: var(--iu-text-muted);
  font-size: 11px;
}
.dot {
  stroke-width: 1.5;
}
.state {
  fill: var(--iu-text);
  font-size: 12px;
}
.note {
  fill: var(--iu-text-muted);
  font-size: 11px;
}
@media (prefers-reduced-motion: no-preference) {
  .running .wing {
    animation: flap 0.42s ease-in-out infinite alternate;
  }
  .waiting {
    animation: hop 2.4s ease-in-out infinite;
  }
}
@keyframes flap {
  from {
    transform: scaleY(1);
  }
  to {
    transform: scaleY(-0.55) translateY(3px);
  }
}
@keyframes hop {
  0%,
  86%,
  100% {
    transform: translate(0, 3px);
  }
  93% {
    transform: translate(0, -2px);
  }
}
</style>
