<script setup lang="ts">
import { computed } from 'vue'
import type { Status } from '@/styles/status'

type Intent = 'neutral' | 'accent' | 'positive' | 'warning' | 'danger' | 'info'

const props = withDefaults(
  defineProps<{
    intent?: Intent
    variant?: 'status' | 'tag' | 'count' | 'solid'
    size?: 'xs' | 'sm' | 'md'
    dot?: boolean
    removable?: boolean
    /**
     * Animates the dot at the status's tempo: running pulses quickly and evenly, awaiting breathes slowly, failed
     * shakes once. Motion only; the label still says the state. Off under prefers-reduced-motion.
     */
    tempo?: Status
  }>(),
  { intent: 'neutral', variant: 'status', size: 'sm', dot: false, removable: false },
)

defineEmits<{ remove: [] }>()

// warning is never colour-only — the glyph is not optional
const glyph = computed(() => (props.intent === 'warning' ? '▲' : null))
</script>

<template>
  <span
    class="iu-badge"
    :class="[`iu-badge--${variant}`, `iu-badge--${intent}`, `iu-badge--${size}`]"
  >
    <span v-if="dot" class="iu-badge__dot" :data-tempo="tempo" aria-hidden="true" />
    <span v-if="glyph" aria-hidden="true">{{ glyph }}</span>
    <slot />
    <button v-if="removable" class="iu-badge__remove" aria-label="Remove" @click="$emit('remove')">
      ×
    </button>
  </span>
</template>

<style>
/* tempo: the dot's motion says how the state is moving */
.iu-badge__dot[data-tempo] {
  position: relative;
}
.iu-badge__dot[data-tempo='running']::before,
.iu-badge__dot[data-tempo='awaiting']::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--intent-dot);
}
.iu-badge__dot[data-tempo='running']::before {
  animation: iu-badge-run var(--iu-dur-run) linear infinite;
}
.iu-badge__dot[data-tempo='awaiting']::before {
  animation: iu-badge-breathe var(--iu-dur-breathe) var(--iu-ease-breathe) infinite;
}
.iu-badge__dot[data-tempo='failed'] {
  animation: iu-badge-shake var(--iu-dur-shake) var(--iu-ease) 1;
}
@keyframes iu-badge-run {
  from {
    opacity: 0.8;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(2.4);
  }
}
@keyframes iu-badge-breathe {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.25;
    transform: scale(1.8);
  }
}
@keyframes iu-badge-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  33% {
    transform: translateX(-2px);
  }
  66% {
    transform: translateX(2px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .iu-badge__dot[data-tempo]::before,
  .iu-badge__dot[data-tempo] {
    animation: none;
  }
  .iu-badge__dot[data-tempo]::before {
    display: none;
  }
}

.iu-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid transparent;
  border-radius: var(--iu-radius-sm);
  padding: 4px 9px;
  font-size: var(--iu-font-size-11);
  /* a status label reads as one token; a narrow cell must not break it over two lines */
  white-space: nowrap;
}

/* Each intent sets only the variables; variants read nothing else from it */
.iu-badge--neutral {
  --intent-fg: var(--iu-text-2);
  --intent-bg: var(--iu-raised);
  --intent-border: var(--iu-border);
  --intent-dot: var(--iu-text-muted);
  --intent-fill: var(--iu-text-2);
  --intent-on-fill: var(--iu-ground);
}
.iu-badge--accent {
  --intent-fg: var(--iu-accent);
  --intent-bg: var(--iu-accent-wash);
  --intent-border: var(--iu-accent-border);
  --intent-dot: var(--iu-accent);
  --intent-fill: var(--iu-accent-fill);
  --intent-on-fill: var(--iu-accent-ink);
}
.iu-badge--positive {
  --intent-fg: var(--iu-positive);
  --intent-bg: var(--iu-positive-wash);
  --intent-border: var(--iu-positive-border);
  --intent-dot: var(--iu-positive);
  --intent-fill: var(--iu-positive);
  --intent-on-fill: var(--iu-accent-ink);
}
.iu-badge--warning {
  --intent-fg: var(--iu-warning);
  --intent-bg: var(--iu-warning-wash);
  --intent-border: var(--iu-warning-border);
  --intent-dot: var(--iu-warning);
  --intent-fill: var(--iu-warning);
  --intent-on-fill: var(--iu-accent-ink);
}
.iu-badge--danger {
  --intent-fg: var(--iu-danger);
  --intent-bg: var(--iu-danger-wash);
  --intent-border: var(--iu-danger-border);
  --intent-dot: var(--iu-danger);
  --intent-fill: var(--iu-danger);
  --intent-on-fill: var(--iu-accent-ink);
}
.iu-badge--info {
  --intent-fg: var(--iu-info);
  --intent-bg: var(--iu-info-wash);
  --intent-border: var(--iu-info-border);
  --intent-dot: var(--iu-info);
  --intent-fill: var(--iu-info);
  --intent-on-fill: var(--iu-accent-ink);
}

/* Status variant — mono, uppercase */
.iu-badge--status {
  font-family: var(--iu-font-mono);
  text-transform: uppercase;
  letter-spacing: var(--iu-tracking-caps-tight);
  background: var(--intent-bg);
  color: var(--intent-fg);
  border-color: var(--intent-border);
}

/* Tag variant — sentence case, normal font; always neutral, intent shows only on the dot */
.iu-badge--tag {
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12);
  text-transform: none;
  letter-spacing: 0;
  padding: 4px 9px;
  background: var(--iu-raised);
  color: var(--iu-text-2);
  border-color: var(--iu-border);
}

/* Count variant — mono, pill-radius; neutral sits in the recessed well */
.iu-badge--count {
  font-family: var(--iu-font-mono);
  text-transform: none;
  border-radius: 9px;
  padding: 2px 7px;
  font-size: var(--iu-font-size-11);
  background: var(--intent-bg);
  color: var(--intent-fg);
  border-color: var(--intent-border);
}
.iu-badge--count.iu-badge--neutral {
  --intent-bg: var(--iu-well);
}

/* Solid variant — full fill; borderless, so the box is 2px smaller than the others */
.iu-badge--solid {
  font-family: var(--iu-font-mono);
  text-transform: uppercase;
  letter-spacing: var(--iu-tracking-caps-tight);
  font-weight: var(--iu-font-weight-medium);
  padding: 4px 9px;
  font-size: var(--iu-font-size-11);
  border: none;
  background: var(--intent-fill);
  color: var(--intent-on-fill);
}

/* Size variants */
.iu-badge--xs {
  font-size: var(--iu-font-size-10);
  padding: 2px 6px;
  border-radius: var(--iu-radius-sm);
}
.iu-badge--sm {
  font-size: var(--iu-font-size-11);
  padding: 4px 9px;
}
.iu-badge--md {
  font-size: var(--iu-font-size-12);
  padding: 5px 11px;
  border-radius: 5px;
}

/* Dot element */
.iu-badge__dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--intent-dot);
}

/* Remove button */
.iu-badge__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  cursor: pointer;
  color: inherit;
  opacity: 0.6;
  transition: opacity 0.12s ease;
}
.iu-badge__remove:hover {
  opacity: 1;
}
</style>
