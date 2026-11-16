<script setup lang="ts">
// Sparkline: a tiny trend line for cards and table rows. Decorative ink; the meaning is in the accessible name
// (min, max and last value), so it never relies on colour or shape alone. Nothing animates.
import { computed } from 'vue'
import { sparkPath } from './sparkline'

const props = withDefaults(
  defineProps<{
    values: number[]
    /** What the values are ("Sessions per day, last 14 days"); min/max/last are appended for assistive tech. */
    label: string
    /** Pixel height; the width fills the container. */
    height?: number
    /** Fill under the line. */
    area?: boolean
  }>(),
  { height: 24, area: false },
)

const W = 100
const paths = computed(() => sparkPath(props.values, W, props.height, 1.5))
const ariaLabel = computed(() => {
  const xs = props.values.filter(Number.isFinite)
  if (!xs.length) return `${props.label}: no data`
  return `${props.label}: min ${Math.min(...xs)}, max ${Math.max(...xs)}, last ${xs.at(-1)}`
})
</script>

<template>
  <svg
    class="iu-sparkline"
    role="img"
    :aria-label="ariaLabel"
    :viewBox="`0 0 ${W} ${height}`"
    preserveAspectRatio="none"
    :style="{ height: `${height}px` }"
  >
    <title>{{ ariaLabel }}</title>
    <path v-if="area && paths.area" class="iu-sparkline__area" :d="paths.area" />
    <path v-if="paths.line" class="iu-sparkline__line" :d="paths.line" />
    <line v-else class="iu-sparkline__empty" x1="0" :y1="height / 2" :x2="W" :y2="height / 2" />
  </svg>
</template>

<style>
.iu-sparkline {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: visible;
}
.iu-sparkline__line {
  fill: none;
  stroke: var(--iu-accent);
  stroke-width: 1.5;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.iu-sparkline__area {
  fill: var(--iu-accent-wash);
  stroke: none;
}
.iu-sparkline__empty {
  stroke: var(--iu-hairline);
  stroke-width: 1;
  stroke-dasharray: 2 3;
  vector-effect: non-scaling-stroke;
}
</style>
