<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: string // caller formats — the tile never does currency math
    delta?: { value: number; label?: string }
    polarity?: 'up-good' | 'up-bad' | 'neutral'
    layout?: 'tile' | 'row'
    state?: 'ready' | 'loading' | 'error'
  }>(),
  { polarity: 'up-good', layout: 'tile', state: 'ready' },
)

const direction = computed(() => {
  const v = props.delta?.value ?? 0
  return v > 0 ? 'up' : v < 0 ? 'down' : 'flat'
})

// glyph is always rendered: direction must never be colour-only
const glyph = computed(() => ({ up: '▲', down: '▼', flat: '—' })[direction.value])

const tone = computed(() => {
  if (props.polarity === 'neutral' || direction.value === 'flat') return 'muted'
  const good = props.polarity === 'up-good' ? 'up' : 'down'
  return direction.value === good ? 'positive' : 'danger'
})
</script>

<template>
  <div class="iu-metric" :class="[`iu-metric--${layout}`, `iu-metric--${state}`]">
    <p class="iu-metric__label">{{ label }}</p>

    <template v-if="state === 'ready'">
      <p class="iu-metric__value">{{ value }}</p>
      <p v-if="delta" class="iu-metric__delta" :data-tone="tone">
        <span aria-hidden="true">{{ glyph }}</span>
        <span class="iu-metric__sr">{{
          direction === 'up' ? 'up' : direction === 'down' ? 'down' : 'flat'
        }}</span>
        {{ Math.abs(delta.value) }}%
        <span v-if="delta.label" class="iu-metric__delta-label">{{ delta.label }}</span>
      </p>
      <slot name="chart" />
      <slot name="footer" />
    </template>

    <div v-else-if="state === 'loading'" class="iu-metric__skeleton" aria-busy="true" />
    <slot v-else name="error">Feed unavailable</slot>
  </div>
</template>

<style>
.iu-metric {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface);
  padding: 16px;
}

.iu-metric--tile {
  gap: 8px;
}

.iu-metric--row {
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
}

.iu-metric--row .iu-metric__label {
  margin: 0;
  flex: 1;
  min-width: 120px;
}

.iu-metric--row .iu-metric__value {
  margin: 0;
}

.iu-metric--row .iu-metric__delta {
  margin: 0;
}

.iu-metric__label {
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}

.iu-metric__value {
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: 28px;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--iu-text);
}

.iu-metric--row .iu-metric__value {
  font-size: 18px;
  flex: 0 0 auto;
  white-space: nowrap;
}

.iu-metric__delta {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-13);
  font-variant-numeric: tabular-nums;
}

.iu-metric__delta[data-tone='positive'] {
  color: var(--iu-positive);
}

.iu-metric__delta[data-tone='danger'] {
  color: var(--iu-danger);
}

.iu-metric__delta[data-tone='muted'] {
  color: var(--iu-text-muted);
}

.iu-metric__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}

.iu-metric__delta-label {
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  margin-left: 4px;
}

.iu-metric__skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 8px 0;
  min-height: 60px;
}

.iu-metric__skeleton::before {
  content: '';
  height: 9px;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-hairline);
  width: 44%;
  animation: iu-pulse 2s ease-in-out infinite;
}

.iu-metric__skeleton::after {
  content: '';
  height: 22px;
  border-radius: var(--iu-radius-md);
  background: var(--iu-hairline);
  width: 66%;
  animation: iu-pulse 2s ease-in-out 0.3s infinite;
}

@keyframes iu-pulse {
  0%,
  100% {
    opacity: 0.6;
  }
  50% {
    opacity: 0.3;
  }
}
</style>
