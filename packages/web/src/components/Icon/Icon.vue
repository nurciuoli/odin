<script setup lang="ts">
import { computed } from 'vue'
import { icons, type IconName } from './icons'

const props = withDefaults(
  defineProps<{
    name: IconName
    size?: 14 | 16 | 20 | 24
    label?: string
  }>(),
  { size: 16 },
)

// stroke thickens as the icon shrinks so weight reads even at 14
const stroke = computed(() => ({ 14: 1.8, 16: 1.7, 20: 1.6, 24: 1.5 })[props.size])
</script>

<template>
  <svg
    viewBox="0 0 24 24"
    :width="size"
    :height="size"
    fill="none"
    stroke="currentColor"
    :stroke-width="stroke"
    stroke-linecap="round"
    stroke-linejoin="round"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : true"
    v-html="icons[name]"
  />
</template>
