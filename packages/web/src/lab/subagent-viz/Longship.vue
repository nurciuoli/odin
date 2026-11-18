<script setup lang="ts">
// Variation D: the longship. The session is the ship and each subagent is one oar-pair and shield on the hull. Oars
// dip and pull while the agent works, are tossed up while it waits on the person, are shipped along the gunwale
// when it is done, and snap when it fails. The shield carries the agent's colour and initial; the crew list below
// says the rest in words.
import { computed } from 'vue'
import { hueOf, stateColor, stateWord, type Sub } from './mock'

const props = defineProps<{ agents: Sub[] }>()
const items = computed(() =>
  props.agents.map((a, i) => {
    const x = 236 + i * 70
    const rest = a.state === 'done' ? 96 : a.state === 'waiting' ? 150 : a.state === 'pending' ? 96 : 24
    return { a, x, rest, hue: hueOf(a.id), color: stateColor[a.state], delay: -i * 0.23 }
  }),
)
const rowing = computed(() => props.agents.filter((a) => a.state === 'running').length)
</script>

<template>
  <div class="ship">
    <svg viewBox="0 0 760 230" role="img" aria-label="Subagents as a longship crew rowing">
      <!-- sail and mast -->
      <path d="M392 124V16" class="mast" />
      <path d="M342 24H442L436 88H348Z" class="sail" />
      <path d="M372 24V88 M392 24V88 M412 24V88" class="sail-line" />
      <text x="392" y="62" class="sail-text" text-anchor="middle">{{ rowing }}</text>
      <path d="M392 16L428 10L392 4" class="pennant" />
      <!-- hull and prow -->
      <path d="M166 112C184 146 262 160 392 160C516 160 596 148 624 108L644 76C650 66 648 56 640 48C646 62 636 66 628 62L620 78Q612 104 596 112Z" class="hull" />
      <path d="M180 120H610" class="gunwale" />
      <!-- sea -->
      <g class="sea">
        <path d="M0 176Q47 168 95 176T190 176T285 176T380 176T475 176T570 176T665 176T760 176" />
        <path d="M-40 196Q7 188 55 196T150 196T245 196T340 196T435 196T530 196T625 196T720 196T815 196" />
      </g>
      <g v-for="i in items" :key="'oar' + i.a.id" :opacity="i.a.state === 'pending' ? 0.4 : 1">
        <!-- oar, drawn pointing down from the pivot, rotated about it -->
        <g :transform="`translate(${i.x} 132)`">
          <g v-if="i.a.state !== 'failed'" class="oar" :class="i.a.state" :style="{ '--rest': i.rest + 'deg', animationDelay: i.delay + 's' }">
            <line y1="-6" y2="54" class="shaft" />
            <path d="M-4 54H4L3 68H-3Z" class="blade" />
          </g>
          <g v-else>
            <line y1="-6" y2="18" class="shaft" style="transform: rotate(20deg)" />
            <path d="M24 176l10 -4 M40 182l8 4" class="splinter" transform="translate(-10 -126)" />
          </g>
        </g>
      </g>
      <g v-for="i in items" :key="'shield' + i.a.id" :opacity="i.a.state === 'pending' ? 0.4 : 1">
        <g :transform="`translate(${i.x} 124)`">
          <circle r="15" class="shield" :style="{ fill: `var(--iu-hue-${i.hue}-bg)`, stroke: i.color }" />
          <text y="4.5" text-anchor="middle" class="shield-letter" :style="{ fill: `var(--iu-hue-${i.hue}-ink)` }">{{ i.a.name[0].toUpperCase() }}</text>
        </g>
      </g>
    </svg>
    <ul class="crew" aria-label="Crew">
      <li v-for="i in items" :key="i.a.id" :class="i.a.state">
        <span class="badge" :style="{ background: `var(--iu-hue-${i.hue}-bg)`, color: `var(--iu-hue-${i.hue}-ink)`, borderColor: i.color }">{{
          i.a.name[0].toUpperCase()
        }}</span>
        <span class="name">{{ i.a.name }}</span>
        <span class="task">{{ i.a.task }}</span>
        <span class="state" :style="{ color: i.color }">{{ stateWord[i.a.state] }}</span>
        <span class="note">{{ i.a.note }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ship {
  font-family: var(--iu-font-sans);
}
svg {
  display: block;
  width: 100%;
}
.mast {
  stroke: var(--iu-border-strong);
  stroke-width: 3;
}
.sail {
  fill: var(--iu-surface-raised);
  stroke: var(--iu-border);
}
.sail-line {
  stroke: var(--iu-hairline);
}
.sail-text {
  fill: var(--iu-text-2);
  font-size: 18px;
  font-weight: 500;
}
.pennant {
  fill: var(--iu-text-muted);
  opacity: 0.7;
}
.hull {
  fill: var(--iu-surface);
  stroke: var(--iu-border-strong);
  stroke-width: 1.5;
}
.gunwale {
  stroke: var(--iu-border-strong);
  stroke-width: 2;
}
.sea path {
  fill: none;
  stroke: var(--iu-info-border);
  stroke-width: 1.5;
}
.shaft {
  stroke: var(--iu-text-muted);
  stroke-width: 3;
  stroke-linecap: round;
}
.blade {
  fill: var(--iu-text-muted);
}
.splinter {
  stroke: var(--iu-danger);
  stroke-width: 2;
  stroke-linecap: round;
}
.oar {
  transform: rotate(var(--rest));
}
.oar.done .shaft,
.oar.done .blade {
  stroke: var(--iu-border-strong);
  fill: var(--iu-border-strong);
}
.oar.waiting .shaft {
  stroke: var(--iu-warning);
}
.oar.waiting .blade {
  fill: var(--iu-warning);
}
.oar.running .shaft {
  stroke: var(--iu-text-2);
}
.oar.running .blade {
  fill: var(--iu-info);
}
.shield {
  stroke-width: 2;
}
.shield-letter {
  font-size: 13px;
  font-weight: 500;
}
.crew {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: grid;
  gap: 6px;
}
.crew li {
  display: grid;
  grid-template-columns: 24px 110px 1fr 120px 190px;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--iu-surface-sunken);
}
.badge {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1.5px solid;
  font-size: 11px;
  font-weight: 500;
}
.name {
  color: var(--iu-text);
  font-weight: 500;
}
.task,
.note {
  color: var(--iu-text-muted);
}
.note {
  text-align: right;
}
@media (prefers-reduced-motion: no-preference) {
  .oar.running {
    animation: row 1.5s ease-in-out infinite alternate;
  }
  .sea {
    animation: swell 5s ease-in-out infinite alternate;
  }
}
@keyframes row {
  from {
    transform: rotate(14deg);
  }
  to {
    transform: rotate(42deg);
  }
}
@keyframes swell {
  to {
    transform: translateX(-24px);
  }
}
@media (max-width: 720px) {
  .crew li {
    grid-template-columns: 24px 1fr auto;
  }
  .task,
  .note {
    display: none;
  }
}
</style>
