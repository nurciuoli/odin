<script setup lang="ts">
// A small flock whose behaviour is the status. CSS only: keyframes fly the dots, transitions bring them
// down to rest. The glyph is never the only signal: callers always pair it with a word ("Working",
// "Waiting on you", …), and colour is the least of what tells the states apart.
//
//   working  tight and quick                     quiet    the same paths, slow and a bit wider
//   waiting  perched on an amber wire, one hops  idle     a few grey dots on a wire, a rare hop
//   landed   exactly three dots in a row, still  failed   scatters once and leaves a small mark
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { FLOCK_MAX_AGENTS, type FlockSize, type FlockState, type FlockTone } from './types'

const props = withDefaults(
  defineProps<{
    state?: FlockState
    // colour of the flying dots (working, quiet); rest states carry their own
    tone?: FlockTone
    size?: FlockSize
    // subagents out: up to three accent dots circle wider than the flock while it flies
    agents?: number
    // with a label the flock is a status region; without one it is decorative
    label?: string
  }>(),
  { state: 'working', tone: 'accent', size: 'md', agents: 0 },
)

// a little longer than --iu-dur-land, so the flight has faded out before it is switched off
const SETTLE_MS = 700

const resting = computed(() => props.state !== 'working' && props.state !== 'quiet')
const dots = computed(() => (props.size === 'lg' || props.size === 'xl' ? 9 : 5))
const out = computed(() =>
  resting.value ? 0 : Math.max(0, Math.min(FLOCK_MAX_AGENTS, Math.floor(props.agents) || 0)),
)

// Settled = the dots have reached their rest places: flight keyframes stop and the hop may start.
// A flock that mounts at rest is settled from the first frame, so a list of them costs nothing.
const settled = ref(resting.value)
let timer: ReturnType<typeof setTimeout> | undefined
watch(
  () => props.state,
  () => {
    clearTimeout(timer)
    settled.value = false
    if (resting.value) timer = setTimeout(() => (settled.value = true), SETTLE_MS)
  },
)
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <span
    class="iu-flock"
    :class="[
      `iu-flock--${size}`,
      size === 'xl' && 'iu-flock--lg',
      state !== 'working' && `iu-flock--${state}`,
      tone !== 'accent' && `iu-flock--${tone}`,
      settled && 'iu-flock--settled',
    ]"
    :role="label ? 'status' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
    ><span class="iu-flock__wire" /><i v-for="n in dots" :key="n" /><TransitionGroup
      name="iu-flock-agent"
      ><em v-for="n in out" :key="n" class="iu-flock__agent" /></TransitionGroup
    ><span class="iu-flock__mark"
  /></span>
</template>

<style>
/* how far the flight reaches: 1 = today's paths, 0 = folded onto the rest place, >1 = scattering.
   Registered so it can transition, which is what lets a flight ease into a perch and back. */
@property --iu-flock-k {
  syntax: '<number>';
  inherits: true;
  initial-value: 1;
}
/* the same for one subagent dot's orbit */
@property --iu-flock-r {
  syntax: '<number>';
  inherits: false;
  initial-value: 1;
}

.iu-flock {
  --iu-flock-k: 1;
  /* per size: flight reach, rest spacing unit, how far below centre the wire's dots sit */
  --iu-flock-sx: 1;
  --iu-flock-sy: 1;
  --iu-flock-ux: 1px;
  --iu-flock-perch: 3px;
  /* 1 = working tempo */
  --iu-flock-pace: 1;
  position: relative;
  display: inline-block;
  flex: none;
  vertical-align: middle;
  width: 34px;
  height: 18px;
  color: var(--iu-accent);
  transition:
    --iu-flock-k var(--iu-dur-land) var(--iu-ease),
    color var(--iu-dur-land) var(--iu-ease);
}

.iu-flock--sm {
  transform: scale(0.62);
  transform-origin: left center;
  margin-right: -13px;
}

.iu-flock--lg {
  --iu-flock-sx: 1.9;
  --iu-flock-sy: 1.5;
  --iu-flock-perch: 5px;
  width: 64px;
  height: 28px;
}
.iu-flock--xl {
  scale: 1.25;
}

.iu-flock--neutral {
  color: var(--iu-text-2);
}

/* ── dots ─────────────────────────────────────────────────────────────────── */
/* `translate` holds the rest place and transitions; `transform` is the flight (and the hop) */
.iu-flock i {
  --iu-flock-x: 0;
  --iu-flock-y: 0px;
  --iu-flock-o: 1;
  --iu-flock-fx: calc(var(--iu-flock-k) * var(--iu-flock-sx));
  --iu-flock-fy: calc(var(--iu-flock-k) * var(--iu-flock-sy));
  position: absolute;
  left: 14px;
  top: 7px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: var(--iu-flock-o);
  translate: calc(var(--iu-flock-x) * var(--iu-flock-ux)) var(--iu-flock-y);
  transition:
    translate var(--iu-dur-land) var(--iu-ease),
    opacity var(--iu-dur-land) var(--iu-ease);
}
.iu-flock--lg i {
  left: 30px;
  top: 12px;
}

.iu-flock i:nth-of-type(1) {
  animation: iu-flock-a calc(2.1s * var(--iu-flock-pace)) ease-in-out infinite alternate;
}
.iu-flock i:nth-of-type(2) {
  animation: iu-flock-b calc(2.6s * var(--iu-flock-pace)) ease-in-out infinite alternate;
  --iu-flock-o: 0.85;
}
.iu-flock i:nth-of-type(3) {
  animation: iu-flock-a calc(3.1s * var(--iu-flock-pace)) ease-in-out
    calc(-1.2s * var(--iu-flock-pace)) infinite alternate-reverse;
  --iu-flock-o: 0.7;
}
.iu-flock i:nth-of-type(4) {
  animation: iu-flock-b calc(1.9s * var(--iu-flock-pace)) ease-in-out
    calc(-0.6s * var(--iu-flock-pace)) infinite alternate-reverse;
  --iu-flock-o: 0.9;
}
.iu-flock i:nth-of-type(5) {
  animation: iu-flock-c calc(2.4s * var(--iu-flock-pace)) ease-in-out
    calc(-0.9s * var(--iu-flock-pace)) infinite alternate;
  --iu-flock-o: 0.6;
}
/* the large flock's extra birds */
.iu-flock i:nth-of-type(6) {
  animation: iu-flock-c calc(2.9s * var(--iu-flock-pace)) ease-in-out
    calc(-2.1s * var(--iu-flock-pace)) infinite alternate-reverse;
  --iu-flock-o: 0.8;
}
.iu-flock i:nth-of-type(7) {
  animation: iu-flock-a calc(2.5s * var(--iu-flock-pace)) ease-in-out
    calc(-0.4s * var(--iu-flock-pace)) infinite alternate;
  --iu-flock-o: 0.65;
}
.iu-flock i:nth-of-type(8) {
  animation: iu-flock-b calc(3.3s * var(--iu-flock-pace)) ease-in-out
    calc(-1.7s * var(--iu-flock-pace)) infinite alternate;
  --iu-flock-o: 0.75;
}
.iu-flock i:nth-of-type(9) {
  animation: iu-flock-c calc(2s * var(--iu-flock-pace)) ease-in-out
    calc(-1.4s * var(--iu-flock-pace)) infinite alternate;
  --iu-flock-o: 0.55;
}

@keyframes iu-flock-a {
  0% {
    transform: translate(calc(-12px * var(--iu-flock-fx)), calc(-5px * var(--iu-flock-fy)));
  }
  35% {
    transform: translate(calc(-2px * var(--iu-flock-fx)), calc(5px * var(--iu-flock-fy)));
  }
  70% {
    transform: translate(calc(9px * var(--iu-flock-fx)), calc(-3px * var(--iu-flock-fy)));
  }
  100% {
    transform: translate(calc(14px * var(--iu-flock-fx)), calc(4px * var(--iu-flock-fy)));
  }
}
@keyframes iu-flock-b {
  0% {
    transform: translate(calc(12px * var(--iu-flock-fx)), calc(5px * var(--iu-flock-fy)));
  }
  40% {
    transform: translate(calc(3px * var(--iu-flock-fx)), calc(-6px * var(--iu-flock-fy)));
  }
  75% {
    transform: translate(calc(-8px * var(--iu-flock-fx)), calc(2px * var(--iu-flock-fy)));
  }
  100% {
    transform: translate(calc(-13px * var(--iu-flock-fx)), calc(-4px * var(--iu-flock-fy)));
  }
}
@keyframes iu-flock-c {
  0% {
    transform: translate(calc(-6px * var(--iu-flock-fx)), calc(6px * var(--iu-flock-fy)));
  }
  50% {
    transform: translate(calc(6px * var(--iu-flock-fx)), calc(-6px * var(--iu-flock-fy)));
  }
  100% {
    transform: translate(calc(-10px * var(--iu-flock-fx)), calc(-2px * var(--iu-flock-fy)));
  }
}

/* still, while flying: three dots, no travel. Sits before the rest states so they place their own. */
@media (prefers-reduced-motion: reduce) {
  .iu-flock i:nth-of-type(1) {
    --iu-flock-x: -8;
  }
  .iu-flock i:nth-of-type(3) {
    --iu-flock-x: 8;
  }
  .iu-flock i:nth-of-type(n + 4) {
    --iu-flock-o: 0;
  }
}

/* ── quiet: still running, nothing new for a while ────────────────────────── */
.iu-flock--quiet {
  --iu-flock-k: 1.15;
  --iu-flock-pace: 4;
}

/* ── rest states ──────────────────────────────────────────────────────────── */
.iu-flock--waiting,
.iu-flock--idle,
.iu-flock--landed {
  --iu-flock-k: 0;
}
/* amber is this state's alone */
.iu-flock--waiting {
  color: var(--iu-warning);
}
.iu-flock--idle {
  color: var(--iu-text-muted);
}
.iu-flock--landed {
  color: var(--iu-positive);
}
.iu-flock--failed {
  --iu-flock-k: 2.2;
  color: var(--iu-danger);
}
.iu-flock--lg.iu-flock--waiting,
.iu-flock--lg.iu-flock--idle {
  --iu-flock-ux: 1.9px;
}
.iu-flock--lg.iu-flock--landed {
  --iu-flock-ux: 1.25px;
}

/* once down, the flight is off: nothing loops but the hop */
.iu-flock.iu-flock--settled i:nth-of-type(n) {
  animation: none;
}

/* waiting: the whole flock on the wire (seven of the large one), unevenly spaced as birds are */
.iu-flock--waiting i:nth-of-type(n) {
  --iu-flock-y: var(--iu-flock-perch);
  --iu-flock-o: 1;
}
.iu-flock--waiting i:nth-of-type(1) {
  --iu-flock-x: -11;
}
.iu-flock--waiting i:nth-of-type(2) {
  --iu-flock-x: -6;
}
.iu-flock--waiting i:nth-of-type(3) {
  --iu-flock-x: -1;
}
.iu-flock--waiting i:nth-of-type(4) {
  --iu-flock-x: 5;
}
.iu-flock--waiting i:nth-of-type(5) {
  --iu-flock-x: 10;
}
.iu-flock--waiting i:nth-of-type(6) {
  --iu-flock-x: -8.5;
}
.iu-flock--waiting i:nth-of-type(7) {
  --iu-flock-x: 7.5;
}
.iu-flock--waiting i:nth-of-type(8) {
  --iu-flock-x: -1;
  --iu-flock-o: 0;
}
.iu-flock--waiting i:nth-of-type(9) {
  --iu-flock-x: 5;
  --iu-flock-o: 0;
}

/* idle: three on the wire (four of the large one), the rest folded behind them */
.iu-flock--idle i:nth-of-type(n) {
  --iu-flock-y: var(--iu-flock-perch);
  --iu-flock-o: 0;
}
.iu-flock--idle i:nth-of-type(3n + 1) {
  --iu-flock-x: -9;
}
.iu-flock--idle i:nth-of-type(3n) {
  --iu-flock-x: -4;
}
.iu-flock--idle i:nth-of-type(3n + 2) {
  --iu-flock-x: 7;
}
.iu-flock--idle i:nth-of-type(7) {
  --iu-flock-x: 2;
}
.iu-flock--idle i:nth-of-type(1),
.iu-flock--idle i:nth-of-type(3),
.iu-flock--idle i:nth-of-type(5),
.iu-flock--idle i:nth-of-type(7) {
  --iu-flock-o: 1;
}

/* landed: exactly three, the dots the Rail folds to */
.iu-flock--landed i:nth-of-type(n) {
  --iu-flock-o: 0;
}
.iu-flock--landed i:nth-of-type(3n + 1) {
  --iu-flock-x: -8;
}
.iu-flock--landed i:nth-of-type(3n) {
  --iu-flock-x: 8;
}
.iu-flock--landed i:nth-of-type(-n + 3) {
  --iu-flock-o: 1;
}

/* failed: the flight widens past the box as the dots fade; only the mark is left */
.iu-flock--failed i:nth-of-type(n) {
  --iu-flock-o: 0;
}

/* one bird hops along the wire and back, now and then */
.iu-flock--waiting.iu-flock--settled i:nth-of-type(4) {
  animation: iu-flock-hop var(--iu-dur-hop) var(--iu-ease) calc(var(--iu-dur-hop) * -0.2) infinite;
}
.iu-flock--idle.iu-flock--settled i:nth-of-type(3) {
  animation: iu-flock-hop calc(var(--iu-dur-hop) * 2.5) var(--iu-ease)
    calc(var(--iu-dur-hop) * -0.5) infinite;
}
@keyframes iu-flock-hop {
  0%,
  41% {
    transform: none;
  }
  43.5% {
    transform: translate(1.5px, -4px);
  }
  46%,
  90% {
    transform: translate(3px, 0);
  }
  92.5% {
    transform: translate(1.5px, -4px);
  }
  95%,
  100% {
    transform: none;
  }
}

/* ── the wire ─────────────────────────────────────────────────────────────── */
.iu-flock__wire {
  position: absolute;
  left: 1px;
  right: 5px;
  top: 13px;
  height: 1px;
  background: currentColor;
  opacity: 0;
  scale: 0 1;
  transition:
    opacity var(--iu-dur-land) var(--iu-ease),
    scale var(--iu-dur-land) var(--iu-ease);
}
.iu-flock--lg .iu-flock__wire {
  left: 5px;
  right: 8px;
  top: 20px;
}
.iu-flock--waiting .iu-flock__wire,
.iu-flock--idle .iu-flock__wire {
  opacity: 0.55;
  scale: 1;
}

/* ── the mark a failure leaves ────────────────────────────────────────────── */
.iu-flock__mark {
  position: absolute;
  left: 12px;
  top: 5px;
  width: 7px;
  height: 7px;
  opacity: 0;
  scale: 0.4;
  transition:
    opacity var(--iu-dur) var(--iu-ease),
    scale var(--iu-dur) var(--iu-ease);
}
.iu-flock--lg .iu-flock__mark {
  left: 28px;
  top: 10px;
}
.iu-flock__mark::before,
.iu-flock__mark::after {
  content: '';
  position: absolute;
  left: -1px;
  right: -1px;
  top: 2.75px;
  height: 1.5px;
  border-radius: 1px;
  background: var(--iu-danger);
  rotate: 45deg;
}
.iu-flock__mark::after {
  rotate: -45deg;
}
.iu-flock--failed .iu-flock__mark {
  opacity: 1;
  scale: 1;
  transition-duration: var(--iu-dur-draw);
  transition-delay: var(--iu-dur);
}

/* ── subagents: peeled off, circling wider than the flock ─────────────────── */
/* always accent, a little larger and steadier than the flock, so they read apart from it in either tone */
.iu-flock__agent {
  --iu-flock-r: 1;
  --iu-flock-fx: calc(var(--iu-flock-r) * var(--iu-flock-sx));
  --iu-flock-fy: calc(var(--iu-flock-r) * var(--iu-flock-sy));
  position: absolute;
  left: 13.5px;
  top: 6.5px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--iu-accent);
  animation: iu-flock-orbit calc(5.2s * var(--iu-flock-pace)) linear infinite;
  transition:
    --iu-flock-r var(--iu-dur-land) var(--iu-ease),
    opacity var(--iu-dur-land) var(--iu-ease);
}
.iu-flock--lg .iu-flock__agent {
  left: 29.5px;
  top: 11.5px;
}
.iu-flock__agent:nth-of-type(2) {
  animation-duration: calc(6.4s * var(--iu-flock-pace));
  animation-delay: calc(-2.3s * var(--iu-flock-pace));
  animation-direction: reverse;
}
.iu-flock__agent:nth-of-type(3) {
  animation-duration: calc(7.3s * var(--iu-flock-pace));
  animation-delay: calc(-4.6s * var(--iu-flock-pace));
}
/* peel off from the middle of the flock, and fold back into it */
.iu-flock-agent-enter-from,
.iu-flock-agent-leave-to {
  --iu-flock-r: 0;
  opacity: 0;
}
@keyframes iu-flock-orbit {
  0%,
  100% {
    transform: translate(calc(17px * var(--iu-flock-fx)), 0);
  }
  12.5% {
    transform: translate(calc(12px * var(--iu-flock-fx)), calc(6.4px * var(--iu-flock-fy)));
  }
  25% {
    transform: translate(0, calc(9px * var(--iu-flock-fy)));
  }
  37.5% {
    transform: translate(calc(-12px * var(--iu-flock-fx)), calc(6.4px * var(--iu-flock-fy)));
  }
  50% {
    transform: translate(calc(-17px * var(--iu-flock-fx)), 0);
  }
  62.5% {
    transform: translate(calc(-12px * var(--iu-flock-fx)), calc(-6.4px * var(--iu-flock-fy)));
  }
  75% {
    transform: translate(0, calc(-9px * var(--iu-flock-fy)));
  }
  87.5% {
    transform: translate(calc(12px * var(--iu-flock-fx)), calc(-6.4px * var(--iu-flock-fy)));
  }
}

/* still: every state holds one frame. Flying: three dots (above); waiting and idle: dots on the wire;
   landed: three dots; failed: the mark. Subagents sit at the corners. */
@media (prefers-reduced-motion: reduce) {
  .iu-flock,
  .iu-flock i:nth-of-type(n),
  .iu-flock__wire,
  .iu-flock__mark,
  .iu-flock__agent {
    animation: none !important;
    transition: none !important;
  }
  .iu-flock__agent {
    transform: translate(calc(13px * var(--iu-flock-sx)), calc(-6px * var(--iu-flock-sy)));
  }
  .iu-flock__agent:nth-of-type(2) {
    transform: translate(calc(-13px * var(--iu-flock-sx)), calc(6px * var(--iu-flock-sy)));
  }
  .iu-flock__agent:nth-of-type(3) {
    transform: translate(calc(13px * var(--iu-flock-sx)), calc(6px * var(--iu-flock-sy)));
  }
}
</style>
