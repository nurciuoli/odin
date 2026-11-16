<script setup lang="ts">
import { computed } from 'vue'
import { statusColor, statusLabel, type Status } from '@/styles/status'

const props = withDefaults(
  defineProps<{
    status: Status
    size?: number
    label?: string
    // set when visible text beside the dot already says the status
    decorative?: boolean
  }>(),
  { size: 8, decorative: false },
)

const ariaLabel = computed(() => props.label ?? statusLabel[props.status])
</script>

<template>
  <span
    class="iu-status-dot"
    :data-status="status"
    :style="{ '--iu-dot': `${size}px`, '--iu-dot-color': statusColor[status] }"
    :role="decorative ? undefined : 'img'"
    :aria-label="decorative ? undefined : ariaLabel"
    :aria-hidden="decorative ? 'true' : undefined"
  >
    <!-- finished: a check, drawn once when it appears -->
    <svg
      v-if="status === 'ok'"
      class="iu-status-dot__check"
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
    >
      <path d="M3.5 9.5l3.5 3.5 7.5-8" pathLength="20" />
    </svg>
  </span>
</template>

<style>
/* shape carries the meaning; colour is a second channel, never the only one */
.iu-status-dot {
  position: relative;
  display: inline-block;
  flex: none;
  vertical-align: middle;
  box-sizing: border-box;
  width: var(--iu-dot);
  height: var(--iu-dot);
  border-radius: 50%;
  background: var(--iu-dot-color);
}

/* hollow: queued, idle, cancelled */
.iu-status-dot[data-status='queued'],
.iu-status-dot[data-status='idle'],
.iu-status-dot[data-status='cancelled'] {
  background: transparent;
  border: 1.5px solid var(--iu-dot-color);
}

/* queued: dashed — "scheduled, not yet" — so it never relies on grey vs grey against idle */
.iu-status-dot[data-status='queued'] {
  border-style: dashed;
  border-color: var(--iu-text-muted);
}

/* cancelled: hollow ring with a diagonal slash */
.iu-status-dot[data-status='cancelled']::after {
  content: '';
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(var(--iu-dot) * 0.9);
  height: 1.5px;
  background: var(--iu-dot-color);
  transform: translate(-50%, -50%) rotate(-45deg);
}

/* Tempo is the status. running: a quick, even pulse (linear, never stops), neutral grey. */
.iu-status-dot[data-status='running']::before {
  content: '';
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 1.5px solid var(--iu-dot-color);
  opacity: 0;
  animation: iu-status-dot-run var(--iu-dur-run) linear infinite;
}

/* awaiting the user: a slow amber breath around a solid dot — patient, not an alarm */
.iu-status-dot[data-status='awaiting']::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--iu-dot-color);
  animation: iu-status-dot-breathe var(--iu-dur-breathe) var(--iu-ease-breathe) infinite;
}

/* finished: no dot fill; the check is drawn once */
.iu-status-dot[data-status='ok'] {
  background: transparent;
  border-radius: 0;
}
.iu-status-dot__check {
  position: absolute;
  inset: calc(var(--iu-dot) * -0.35);
  width: calc(var(--iu-dot) * 1.7);
  height: calc(var(--iu-dot) * 1.7);
  stroke: var(--iu-dot-color);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.iu-status-dot__check path {
  stroke-dasharray: 20;
  animation: iu-status-dot-draw var(--iu-dur-draw) var(--iu-ease) both;
}

/* failed: one short shake, once; then it stays put */
.iu-status-dot[data-status='failed'] {
  animation: iu-status-dot-shake var(--iu-dur-shake) var(--iu-ease) 1;
}

@keyframes iu-status-dot-run {
  0% {
    opacity: 0.9;
    transform: scale(0.6);
  }
  100% {
    opacity: 0;
    transform: scale(1.5);
  }
}
@keyframes iu-status-dot-breathe {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.25;
    transform: scale(1.6);
  }
}
@keyframes iu-status-dot-draw {
  from {
    stroke-dashoffset: 20;
  }
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes iu-status-dot-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  25% {
    transform: translateX(-2px);
  }
  50% {
    transform: translateX(2px);
  }
  75% {
    transform: translateX(-1px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .iu-status-dot[data-status='running']::before,
  .iu-status-dot[data-status='awaiting']::before,
  .iu-status-dot[data-status='failed'],
  .iu-status-dot__check path {
    animation: none;
  }
  .iu-status-dot[data-status='running']::before {
    opacity: 0.6;
  }
  .iu-status-dot[data-status='awaiting']::before {
    display: none;
  }
}

/* warning: a triangle drawn slightly past the box so it reads at the same
   weight as a circle, without changing the layout box (rails stay aligned) */
.iu-status-dot[data-status='warning'] {
  background: transparent;
  border-radius: 0;
}
.iu-status-dot[data-status='warning']::before {
  content: '';
  position: absolute;
  inset: calc(var(--iu-dot) * -0.12);
  background: var(--iu-dot-color);
  clip-path: polygon(50% 4%, 100% 92%, 0 92%);
}
</style>
