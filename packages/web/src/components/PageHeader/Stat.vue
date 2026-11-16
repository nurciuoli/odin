<script setup lang="ts">
import { computed } from 'vue'

export type StatIntent = 'neutral' | 'positive' | 'warning' | 'danger'
export type StatSize = 'sm' | 'md'

const props = withDefaults(
  defineProps<{
    label: string
    value: string // caller formats
    intent?: StatIntent
    size?: StatSize
    hint?: string // e.g. "of 412"
  }>(),
  { intent: 'neutral', size: 'sm' },
)

// warning and danger are never colour-only — same rule as IuMeter
const display = computed(() =>
  props.intent === 'warning' || props.intent === 'danger' ? `▲ ${props.value}` : props.value,
)
</script>

<template>
  <div class="iu-stat" :class="[`iu-stat--${size}`, `iu-stat--${intent}`]">
    <div class="iu-stat__label">{{ label }}</div>
    <div class="iu-stat__value">
      <slot name="value">{{ display }}</slot>
      <span v-if="hint" class="iu-stat__hint">{{ hint }}</span>
    </div>
  </div>
</template>

<style>
.iu-stat {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.iu-stat__label {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.iu-stat__value {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  font-family: var(--iu-font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  color: var(--iu-text);
}

.iu-stat--sm .iu-stat__value {
  font-size: 15px;
}
.iu-stat--md .iu-stat__value {
  font-size: 19px;
}

.iu-stat--positive .iu-stat__value {
  color: var(--iu-positive);
}
.iu-stat--warning .iu-stat__value {
  color: var(--iu-warning);
}
.iu-stat--danger .iu-stat__value {
  color: var(--iu-danger);
}

.iu-stat__hint {
  font-size: var(--iu-font-size-11-5);
  letter-spacing: 0;
  color: var(--iu-text-muted);
}
/* a hint qualifies its value ("▲ 0.23%", "of 412"), so it shares the value's intent */
.iu-stat--positive .iu-stat__hint {
  color: var(--iu-positive);
}
.iu-stat--warning .iu-stat__hint {
  color: var(--iu-warning);
}
.iu-stat--danger .iu-stat__hint {
  color: var(--iu-danger);
}
</style>
