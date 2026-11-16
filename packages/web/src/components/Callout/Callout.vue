<script lang="ts">
export type CalloutIntent = 'neutral' | 'info' | 'positive' | 'warning' | 'danger'
export type CalloutVariant = 'bar' | 'subtle' | 'inline'
</script>

<script setup lang="ts">
import { computed } from 'vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuButton from '@/components/Button/Button.vue'
import type { IconName } from '@/components/Icon/icons'

const props = withDefaults(
  defineProps<{
    intent?: CalloutIntent
    title?: string
    icon?: IconName | null
    variant?: CalloutVariant
    dismissible?: boolean
    live?: boolean
  }>(),
  {
    intent: 'info',
    variant: 'bar',
    dismissible: false,
    live: false,
  },
)

const emit = defineEmits<{ dismiss: [] }>()

const defaultIcon: Record<CalloutIntent, IconName> = {
  neutral: 'info',
  info: 'info',
  positive: 'check',
  warning: 'alert',
  danger: 'alert',
}

// undefined → intent default; null → no icon
const iconName = computed<IconName | null>(() =>
  props.icon === null ? null : (props.icon ?? defaultIcon[props.intent]),
)
</script>

<template>
  <div
    :class="[
      'iu-callout',
      `iu-callout--${intent}`,
      `iu-callout--${variant}`,
      { 'iu-callout--no-title': !title && !$slots.title },
    ]"
    :role="live ? 'alert' : 'note'"
  >
    <span v-if="$slots.icon || iconName" class="iu-callout__icon" aria-hidden="true">
      <slot name="icon">
        <IuIcon v-if="iconName" :name="iconName" :size="14" />
      </slot>
    </span>

    <div class="iu-callout__main">
      <div v-if="title || $slots.title" class="iu-callout__title">
        <slot name="title">{{ title }}</slot>
      </div>
      <div v-if="$slots.default" class="iu-callout__body"><slot /></div>
    </div>

    <div v-if="$slots.actions" class="iu-callout__actions"><slot name="actions" /></div>

    <IuButton
      v-if="dismissible"
      class="iu-callout__dismiss"
      variant="ghost"
      size="sm"
      icon-only
      aria-label="Dismiss"
      @click="emit('dismiss')"
    >
      <template #icon><IuIcon name="close" :size="14" /></template>
    </IuButton>
  </div>
</template>

<style>
.iu-callout {
  --callout-ink: var(--iu-text-muted);
  --callout-wash: var(--iu-raised);
  --callout-border: var(--iu-hairline);
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 11px;
  min-width: 0;
  padding: 12px 15px;
  border-radius: var(--iu-radius-lg);
}

.iu-callout--info {
  --callout-ink: var(--iu-info);
  --callout-wash: var(--iu-info-wash);
  --callout-border: var(--iu-info-border);
}
.iu-callout--positive {
  --callout-ink: var(--iu-positive);
  --callout-wash: var(--iu-positive-wash);
  --callout-border: var(--iu-positive-border);
}
.iu-callout--warning {
  --callout-ink: var(--iu-warning);
  --callout-wash: var(--iu-warning-wash);
  --callout-border: var(--iu-warning-border);
}
.iu-callout--danger {
  --callout-ink: var(--iu-danger);
  --callout-wash: var(--iu-danger-wash);
  --callout-border: var(--iu-danger-border);
}

.iu-callout--bar {
  background: var(--iu-surface);
  border: 1px solid var(--iu-hairline);
  border-left: 3px solid var(--callout-ink);
}
.iu-callout--subtle {
  background: var(--callout-wash);
  border: 1px solid var(--callout-border);
}
.iu-callout--inline {
  /* an inline note is icon + text; the icon never drops onto its own line */
  flex-wrap: nowrap;
  padding: 0;
  border: 0;
  gap: 7px;
  font-size: var(--iu-font-size-12);
  line-height: 18px;
  color: var(--iu-text-2);
}

.iu-callout__icon {
  display: flex;
  align-items: center;
  flex: none;
  height: 19px;
  color: var(--callout-ink);
}
.iu-callout--inline .iu-callout__icon {
  height: 18px;
}

.iu-callout__main {
  flex: 1 1 240px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.iu-callout__title {
  font-size: var(--iu-font-size-13-5);
  font-weight: var(--iu-font-weight-medium);
  line-height: 19px;
  color: var(--iu-text);
}
.iu-callout__body {
  font-size: var(--iu-font-size-12-5);
  line-height: var(--iu-leading-normal);
  color: var(--iu-text-2);
}

/* Body-only: the body is the message, so it reads at full strength */
.iu-callout--no-title:not(.iu-callout--inline) .iu-callout__body {
  font-size: var(--iu-font-size-13);
  line-height: 19px;
  color: var(--iu-text);
}

.iu-callout--inline .iu-callout__main {
  gap: 0;
}
.iu-callout--inline .iu-callout__title,
.iu-callout--inline .iu-callout__body {
  font-size: var(--iu-font-size-12);
  line-height: 18px;
  color: var(--iu-text-2);
}
.iu-callout--inline .iu-callout__title {
  font-weight: var(--iu-font-weight-medium);
}

.iu-callout__actions {
  flex: none;
  align-self: center;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}

.iu-callout__dismiss {
  flex: none;
  align-self: flex-start;
  margin: -3px -7px 0 0;
}
</style>
