<script setup lang="ts">
// One Overview panel: a card with a heading, an optional action or note beside it, and the panel's body.
import { IuCard } from '@/components/Card'

defineProps<{ id: string; title: string }>()
</script>

<template>
  <section :aria-labelledby="id" class="ov-panel">
    <IuCard class="ov-panel__card">
      <template #header>
        <div class="ov-panel__top">
          <h2 :id="id" class="ov-panel__title">{{ title }}</h2>
          <slot name="actions" />
        </div>
      </template>
      <div class="ov-panel__body"><slot /></div>
    </IuCard>
  </section>
</template>

<style>
.ov-panel {
  display: flex;
  min-width: 0;
}
.ov-panel__card {
  flex: 1;
  min-width: 0;
}
.ov-panel__top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.ov-panel__title {
  margin: 0;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-semibold);
}
.ov-panel__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
</style>
