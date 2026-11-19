<script setup lang="ts">
import { computed, useSlots } from 'vue'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
type Size = 'sm' | 'md' | 'lg'

const props = withDefaults(
  defineProps<{
    variant?: Variant
    size?: Size
    loading?: boolean
    disabled?: boolean
    iconOnly?: boolean
    as?: string
    /** Native button type. Defaults to `button` so a library button inside a form never submits it by accident. */
    type?: 'button' | 'submit' | 'reset'
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    loading: false,
    disabled: false,
    iconOnly: false,
    as: 'button',
    type: 'button',
  },
)

const slots = useSlots()
const isDisabled = computed(() => props.disabled || props.loading)
const classes = computed(() => [
  'iu-btn',
  `iu-btn--${props.variant}`,
  `iu-btn--${props.size}`,
  { 'iu-btn--icon': props.iconOnly, 'iu-btn--loading': props.loading },
])
</script>

<template>
  <component
    :is="as"
    :class="classes"
    :type="as === 'button' ? type : undefined"
    :disabled="as === 'button' ? isDisabled : undefined"
    :aria-busy="loading || undefined"
    :aria-disabled="isDisabled || undefined"
  >
    <span v-if="loading" class="iu-btn__spinner" aria-hidden="true" />
    <slot v-else-if="slots.icon" name="icon" />
    <span v-if="!iconOnly" class="iu-btn__label"><slot /></span>
    <slot name="trailing" />
  </component>
</template>

<style>
.iu-btn {
  position: relative;
  overflow: hidden;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font: inherit;
  font-weight: var(--iu-font-weight-medium);
  line-height: var(--iu-leading-none);
  white-space: nowrap;
  border: 1px solid transparent;
  border-radius: var(--iu-radius-sm);
  cursor: pointer;
  transition:
    background-color 0.08s linear,
    border-color 0.08s linear,
    color 0.08s linear;
}
.iu-btn:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.iu-btn:disabled,
.iu-btn[aria-disabled='true'] {
  background: var(--iu-surface-sunken);
  border-color: var(--iu-border-quiet);
  color: var(--iu-text-disabled);
  cursor: not-allowed;
}

.iu-btn--sm {
  height: 24px;
  padding: 0 8px;
  gap: 5px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  letter-spacing: 0;
}
.iu-btn--md {
  height: 30px;
  padding: 0 12px;
  font-size: var(--iu-font-size-13);
}
.iu-btn--lg {
  height: 36px;
  padding: 0 16px;
  font-size: var(--iu-font-size-14);
}
.iu-btn--icon {
  padding: 0;
}
.iu-btn--icon.iu-btn--sm {
  width: 24px;
}
.iu-btn--icon.iu-btn--md {
  width: 30px;
}
.iu-btn--icon.iu-btn--lg {
  width: 36px;
}

.iu-btn--primary {
  background: var(--iu-accent-fill);
  border-color: var(--iu-accent-fill);
  color: var(--iu-accent-ink);
}
.iu-btn--primary:hover:not(:disabled) {
  background: var(--iu-accent-hover);
  border-color: var(--iu-accent);
}

.iu-btn--secondary {
  background: transparent;
  border-color: var(--iu-border);
  color: var(--iu-text);
}
.iu-btn--secondary:hover:not(:disabled) {
  background: var(--iu-surface);
  border-color: var(--iu-border-strong);
}

.iu-btn--ghost {
  background: transparent;
  border-color: transparent;
  color: var(--iu-text-muted);
}
.iu-btn--ghost:hover:not(:disabled) {
  background: var(--iu-surface);
  border-color: var(--iu-border);
  color: var(--iu-text);
}

.iu-btn--danger {
  background: transparent;
  border-color: var(--iu-danger-border);
  color: var(--iu-danger);
}
.iu-btn--danger:hover:not(:disabled) {
  background: var(--iu-danger-wash);
  border-color: var(--iu-danger);
}

.iu-btn--link {
  background: none;
  border-color: transparent;
  height: auto;
  padding: 0 1px;
  color: var(--iu-accent);
}
.iu-btn--link:hover:not(:disabled) {
  text-decoration: underline;
  text-underline-offset: 3px;
}

/* Trailing-slot helper: key hint chip, e.g. <template #trailing><kbd class="iu-btn__kbd">⌘K</kbd></template> */
.iu-btn__kbd {
  display: inline-flex;
  align-items: center;
  height: 1.5em;
  padding: 0 4px;
  margin-right: -4px;
  margin-left: 2px;
  font: 500 10px/1 var(--iu-font-mono);
  color: var(--iu-text-muted);
  border: 1px solid var(--iu-border);
  border-radius: 2px;
  background: var(--iu-surface-sunken);
}
.iu-btn--primary .iu-btn__kbd {
  color: var(--iu-accent-ink);
  background: transparent;
  border-color: color-mix(in srgb, var(--iu-accent-ink) 40%, transparent);
}

/* Loading: slim indeterminate bar along the bottom edge, no layout shift */
.iu-btn__spinner {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  overflow: hidden;
  background: color-mix(in srgb, currentColor 20%, transparent);
}
.iu-btn__spinner::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 35%;
  background: currentColor;
  animation: iu-btn-bar 1s linear infinite;
}
.iu-btn--loading {
  cursor: progress;
}
@keyframes iu-btn-bar {
  from {
    left: -35%;
  }
  to {
    left: 100%;
  }
}
</style>
