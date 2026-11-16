<script setup lang="ts">
import { IuCard } from '@/components/Card'

defineProps<{ title: string; description?: string }>()
</script>

<template>
  <IuCard as="section" elevation="raised" class="form-section">
    <template #header>
      <div class="form-section__top">
        <div class="form-section__head">
          <h2 class="form-section__title">{{ title }}</h2>
          <p v-if="description" class="form-section__desc">{{ description }}</p>
        </div>
        <div v-if="$slots.aside" class="form-section__aside"><slot name="aside" /></div>
      </div>
    </template>
    <div class="form-section__body"><slot /></div>
  </IuCard>
</template>

<style>
.form-section__top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.form-section__head {
  min-width: 0;
}
.form-section__aside {
  flex: none;
}
.form-section__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.form-section__desc {
  margin: 3px 0 0;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.form-section__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
/* two columns when there is room; fields keep a sensible minimum width */
.form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
}
.form-grid > .form-span {
  grid-column: 1 / -1;
}
.form-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}
.form-group__label {
  padding: 0;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-2);
}
.form-group__hint {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.form-radio {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.form-radio__hint {
  margin: 0 0 0 26px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
