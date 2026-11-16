<script setup lang="ts">
withDefaults(
  defineProps<{
    minColumn?: string
  }>(),
  { minColumn: '150px' },
)
</script>

<template>
  <div class="iu-stat-grid" :style="{ '--iu-stat-min': minColumn }">
    <slot />
  </div>
</template>

<style>
.iu-stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(var(--iu-stat-min, 150px), 1fr));
  gap: 1px;
  background: var(--iu-hairline);
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-lg);
  overflow: hidden;
}

.iu-stat-grid > .iu-stat {
  background: var(--iu-surface);
  padding: 12px 14px;
}
</style>
