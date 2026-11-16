<script setup lang="ts">
import Property from './Property.vue'

export interface PropertyItem {
  label: string
  value: string
  mono?: boolean
}

withDefaults(
  defineProps<{
    items?: PropertyItem[]
    labelWidth?: string
    density?: 'compact' | 'comfortable'
    layout?: 'inline' | 'stacked'
  }>(),
  { labelWidth: '80px', density: 'comfortable', layout: 'inline' },
)
</script>

<template>
  <dl
    class="iu-props"
    :class="[`iu-props--${density}`, `iu-props--${layout}`]"
    :style="{ '--iu-props-label-w': labelWidth }"
  >
    <Property
      v-for="(item, i) in items"
      :key="i"
      :label="item.label"
      :value="item.value"
      :mono="item.mono"
    />
    <slot />
  </dl>
</template>

<style>
.iu-props {
  display: flex;
  flex-direction: column;
  margin: 0;
}
.iu-props--compact {
  gap: 6px;
}
.iu-props--comfortable {
  gap: 9px;
}
</style>
