<script setup lang="ts">
import IuEyebrow from '@/components/Eyebrow/Eyebrow.vue'

defineProps<{ label: string }>()
</script>

<template>
  <div class="iu-daydivider" role="separator" :aria-label="label">
    <span class="iu-daydivider__rule" aria-hidden="true" />
    <IuEyebrow class="iu-daydivider__label" aria-hidden="true">{{ label }}</IuEyebrow>
    <span class="iu-daydivider__rule" aria-hidden="true" />
  </div>
</template>

<style>
.iu-daydivider {
  display: flex;
  align-items: center;
  gap: 12px;
}

.iu-daydivider__rule {
  flex: 1;
  height: 1px;
  background: var(--iu-hairline);
}

.iu-daydivider__label {
  flex: none;
  white-space: nowrap;
}
</style>
