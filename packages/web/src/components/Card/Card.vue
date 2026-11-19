<script setup lang="ts">
import { computed, useSlots } from 'vue'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import type { Status } from '@/styles/status'

const props = withDefaults(
  defineProps<{
    elevation?: 'flat' | 'raised' | 'floating' | 'well'
    density?: 'compact' | 'comfortable'
    intent?: 'positive' | 'warning' | 'danger' | null
    selected?: boolean
    as?: string
  }>(),
  { elevation: 'raised', density: 'comfortable', intent: null, selected: false, as: 'div' },
)

const slots = useSlots()

// card intents are a subset of the status vocabulary; the dot is decorative because
// the card's own text carries the state
const INTENT_STATUS: Record<'positive' | 'warning' | 'danger', Status> = {
  positive: 'ok',
  warning: 'warning',
  danger: 'failed',
}
const dotStatus = computed(() => (props.intent ? INTENT_STATUS[props.intent] : null))
</script>

<template>
  <component
    :is="as"
    class="iu-card"
    :class="[
      `iu-card--${elevation}`,
      `iu-card--${density}`,
      intent && `iu-card--${intent}`,
      { 'iu-card--selected': selected },
    ]"
    :aria-current="selected || undefined"
  >
    <span v-if="dotStatus" class="iu-card__dot">
      <IuStatusDot :status="dotStatus" :size="9" decorative />
    </span>
    <header v-if="slots.header" class="iu-card__header"><slot name="header" /></header>
    <div class="iu-card__body"><slot /></div>
    <footer v-if="slots.footer" class="iu-card__footer"><slot name="footer" /></footer>
  </component>
</template>

<style>
/* column flex + a growing body: cards stretched by a grid row keep their footer at
   the bottom and give the body the full height (equal-height tiles) */
.iu-card {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-lg);
}
.iu-card__body {
  flex: 1;
  min-height: 0;
}
.iu-card__dot {
  position: absolute;
  top: 50%;
  left: 10px;
  display: flex;
  transform: translateY(-50%);
}
.iu-card--flat {
  background: var(--iu-ground);
  border-color: var(--iu-hairline);
}
.iu-card--raised {
  background: var(--iu-surface);
  border-color: var(--iu-hairline);
  border-top-color: var(--iu-lip-edge);
  box-shadow: var(--iu-lip);
}
.iu-card--floating {
  background: var(--iu-raised);
  border-color: var(--iu-border);
  border-top-color: var(--iu-lip-edge);
  box-shadow: var(--iu-lip), var(--iu-shadow-raised);
}
.iu-card--well {
  background: var(--iu-well);
  border-color: var(--iu-hairline);
}
.iu-card--selected {
  border-color: var(--iu-accent);
}
.iu-card--comfortable .iu-card__body {
  padding: 18px;
}
.iu-card--compact .iu-card__body {
  padding: 12px;
}
.iu-card__header {
  padding: 14px 18px;
  border-bottom: 1px solid var(--iu-hairline);
}
.iu-card__footer {
  padding: 12px 18px;
  border-top: 1px solid var(--iu-hairline);
  background: var(--iu-surface-sunken);
}
</style>
