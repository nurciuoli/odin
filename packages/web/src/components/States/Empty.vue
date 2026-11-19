<script setup lang="ts">
// IuEmpty.vue — the design bundle documents this component only through the
// API table + the "Empty · three kinds" mockup section (no embedded SFC
// source), so the template/logic below is a from-scratch, real implementation
// built to that contract.
import { computed } from 'vue'
import { IuIcon } from '@/components/Icon'
import type { IconName } from '@/components/Icon'

const props = withDefaults(
  defineProps<{
    /** which of the three empty situations this is — drives icon, tone and the eyebrow label */
    kind?: 'first-run' | 'filtered' | 'cleared'
    title: string
    /** one sentence; use the default slot instead for richer (e.g. mixed-mono) copy */
    body?: string
    /** show the small kind label under the content; turn off where it only adds noise */
    eyebrow?: boolean
  }>(),
  { kind: 'first-run', eyebrow: true },
)

const ICON: Record<typeof props.kind, IconName> = {
  'first-run': 'terminal',
  filtered: 'filter',
  cleared: 'check',
}

const EYEBROW: Record<typeof props.kind, string> = {
  'first-run': 'first run',
  filtered: 'filtered to nothing',
  cleared: 'cleared · a good outcome',
}

const icon = computed(() => ICON[props.kind])
const eyebrowText = computed(() => EYEBROW[props.kind])
</script>

<template>
  <div class="iu-empty" :class="`iu-empty--${kind}`">
    <div class="iu-empty__icon"><IuIcon :name="icon" :size="20" /></div>
    <div class="iu-empty__title">{{ title }}</div>
    <div v-if="body || $slots.default" class="iu-empty__body">
      <slot>{{ body }}</slot>
    </div>
    <div v-if="$slots.action" class="iu-empty__action"><slot name="action" /></div>
    <div v-if="eyebrow" class="iu-empty__eyebrow">{{ eyebrowText }}</div>
  </div>
</template>

<style>
.iu-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface);
  padding: 32px 22px;
}

.iu-empty__icon {
  width: 40px;
  height: 40px;
  border-radius: var(--iu-radius-lg);
  border: 1px dashed var(--iu-border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--iu-text-disabled);
  flex: none;
}

/* the "cleared" kind is a success, not a failure — it earns positive ink,
   never the neutral/dashed-danger treatment the other two kinds share */
.iu-empty--cleared .iu-empty__icon {
  border-color: var(--iu-positive-border);
  color: var(--iu-positive);
}

.iu-empty__title {
  font-size: 15px;
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text);
}

.iu-empty__body {
  font-size: var(--iu-font-size-13-5);
  color: var(--iu-text-2);
  line-height: var(--iu-leading-relaxed);
  max-width: 34ch;
}

.iu-empty__body code,
.iu-empty__body [data-mono] {
  font-family: var(--iu-font-mono);
  color: var(--iu-text);
}

.iu-empty__action {
  margin-top: 4px;
}

.iu-empty__eyebrow {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-disabled);
  margin-top: 4px;
}
</style>
