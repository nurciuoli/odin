<script setup lang="ts">
import { computed } from 'vue'
import type { Intent } from '@/styles/status'

export type MeterIntent = Intent | 'auto'

const props = withDefaults(
  defineProps<{
    value: number
    max?: number
    label?: string
    /** accessible name when there's no visible label (e.g. a bare progress bar under a count) */
    ariaLabel?: string
    valueLabel?: string
    intent?: MeterIntent
    thresholds?: { warning?: number; danger?: number }
    layout?: 'stacked' | 'inline' | 'caption'
    size?: 'sm' | 'md'
    indeterminate?: boolean
  }>(),
  {
    max: 100,
    intent: 'accent',
    thresholds: () => ({ warning: 0.8, danger: 0.95 }),
    layout: 'stacked',
    size: 'sm',
    indeterminate: false,
  },
)

// Unclamped fraction of max — drives auto thresholds and the default label, so
// an over-max value still reads as its real number (120%) while the fill caps at full.
const ratio = computed(() => {
  if (!(props.max > 0) || !Number.isFinite(props.value)) return 0
  return Math.max(0, props.value / props.max)
})
const fillPct = computed(() => Math.min(100, ratio.value * 100))

const resolved = computed<Intent>(() => {
  if (props.intent !== 'auto') return props.intent
  if (ratio.value >= (props.thresholds.danger ?? 0.95)) return 'danger'
  if (ratio.value >= (props.thresholds.warning ?? 0.8)) return 'warning'
  return 'positive'
})

// warning and danger are never colour-only — the glyph is not optional
const glyph = computed(() => resolved.value === 'warning' || resolved.value === 'danger')

const valueText = computed(
  () => props.valueLabel ?? (props.indeterminate ? '' : `${Math.round(ratio.value * 100)}%`),
)
const valueNow = computed(() => Math.min(Math.max(props.value, 0), props.max))

const fillStyle = computed(() => (props.indeterminate ? undefined : { width: `${fillPct.value}%` }))
</script>

<template>
  <div
    class="iu-meter"
    :class="[`iu-meter--${layout}`, `iu-meter--${size}`]"
    :data-intent="resolved"
    :data-indeterminate="indeterminate || undefined"
    :role="indeterminate ? 'progressbar' : 'meter'"
    aria-valuemin="0"
    :aria-valuemax="max"
    :aria-valuenow="indeterminate ? undefined : valueNow"
    :aria-valuetext="indeterminate ? undefined : valueText"
    :aria-label="label ?? ariaLabel"
  >
    <div class="iu-meter__grid">
      <span v-if="label || $slots.label" class="iu-meter__label">
        <slot name="label">{{ label }}</slot>
      </span>
      <span v-if="valueText || $slots.value" class="iu-meter__value">
        <span v-if="glyph" class="iu-meter__glyph" aria-hidden="true">▲</span
        ><slot name="value">{{ valueText }}</slot>
      </span>
      <div class="iu-meter__track">
        <div
          class="iu-meter__fill"
          :class="{ 'iu-meter__fill--indeterminate': indeterminate }"
          :style="fillStyle"
        />
      </div>
    </div>
    <div v-if="$slots.hint" class="iu-meter__hint">
      <slot name="hint" />
    </div>
  </div>
</template>

<style>
.iu-meter {
  --iu-meter-h: 4px;
  min-width: 0;
}
.iu-meter--md {
  --iu-meter-h: 6px;
}

.iu-meter__grid {
  display: grid;
  align-items: center;
  min-width: 0;
}
.iu-meter--stacked .iu-meter__grid {
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-areas:
    'label value'
    'track track';
  row-gap: 5px;
}
.iu-meter--inline .iu-meter__grid {
  grid-template-columns: auto minmax(0, 1fr) auto;
  grid-template-areas: 'label track value';
}

.iu-meter__label {
  grid-area: label;
  min-width: 0;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.iu-meter--inline .iu-meter__label {
  margin-right: 10px;
}

/* caption: bar on top, value as a small caption under it — for table/list rows */
.iu-meter--caption .iu-meter__grid {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: 'track' 'value';
  row-gap: 4px;
}
.iu-meter--caption .iu-meter__label {
  display: none;
}
.iu-meter--caption .iu-meter__value {
  justify-self: start;
  font-size: var(--iu-font-size-10-5);
  color: var(--iu-text-muted);
}

.iu-meter__value {
  grid-area: value;
  justify-self: end;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
  font-variant-numeric: tabular-nums;
  color: var(--iu-text);
  white-space: nowrap;
}
.iu-meter--inline .iu-meter__value {
  justify-self: start;
  margin-left: 10px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}

.iu-meter__glyph {
  margin-right: 0.4em;
}

.iu-meter__track {
  grid-area: track;
  position: relative;
  height: var(--iu-meter-h);
  border-radius: calc(var(--iu-meter-h) / 2);
  background: var(--iu-hairline);
  overflow: hidden;
  min-width: 0;
}

.iu-meter__fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--iu-accent);
  transition: width var(--iu-dur) var(--iu-ease);
}
.iu-meter[data-intent='neutral'] .iu-meter__fill {
  background: var(--iu-text-muted);
}
.iu-meter[data-intent='accent'] .iu-meter__fill {
  background: var(--iu-accent);
}
.iu-meter[data-intent='info'] .iu-meter__fill {
  background: var(--iu-info);
}
.iu-meter[data-intent='positive'] .iu-meter__fill {
  background: var(--iu-positive);
}
.iu-meter[data-intent='warning'] .iu-meter__fill {
  background: var(--iu-warning);
}
.iu-meter[data-intent='danger'] .iu-meter__fill {
  background: var(--iu-danger);
}

.iu-meter[data-intent='warning'] .iu-meter__value {
  color: var(--iu-warning);
}
.iu-meter[data-intent='danger'] .iu-meter__value {
  color: var(--iu-danger);
}

/* Indeterminate: a 35% segment sliding across the track */
.iu-meter__fill--indeterminate {
  left: 0;
  width: 35%;
  animation: iu-meter-slide 1.4s linear infinite;
}
@keyframes iu-meter-slide {
  from {
    left: -35%;
  }
  to {
    left: 100%;
  }
}

.iu-meter__hint {
  margin-top: 6px;
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text-2);
}

@media (prefers-reduced-motion: reduce) {
  .iu-meter__fill {
    transition: none;
  }
  .iu-meter__fill--indeterminate {
    animation: none;
    left: 0;
    opacity: 0.5;
  }
}
</style>
