<script setup lang="ts">
import { useId } from 'vue'

withDefaults(
  defineProps<{
    label?: string
    disabled?: boolean
    /** `sm`: a 28x16 switch with a 13px label, for dense rows */
    size?: 'sm' | 'md'
  }>(),
  { disabled: false, size: 'md' },
)

const model = defineModel<boolean>({ default: false })

const id = useId()

function toggle() {
  model.value = !model.value
}
</script>

<template>
  <span class="iu-switch-row" :class="{ 'iu-switch-row--sm': size === 'sm' }">
    <label v-if="label || $slots.default" :for="id" class="iu-switch-row__label"
      ><slot>{{ label }}</slot></label
    >
    <button
      :id="id"
      type="button"
      role="switch"
      class="iu-switch"
      :class="{
        'iu-switch--on': model,
        'iu-switch--disabled': disabled,
        'iu-switch--sm': size === 'sm',
      }"
      :aria-checked="model"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="iu-switch__thumb" />
    </button>
  </span>
</template>

<style>
.iu-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.iu-switch-row__label {
  font-size: var(--iu-font-size-14);
  color: var(--iu-text);
  cursor: pointer;
}

.iu-switch {
  position: relative;
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  width: 38px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 11px;
  background: var(--iu-border);
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.iu-switch__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--iu-text-muted);
  transition:
    transform 0.12s ease,
    background-color 0.12s ease;
}

.iu-switch--on {
  background: var(--iu-accent-fill);
}
.iu-switch--on .iu-switch__thumb {
  transform: translateX(16px);
  background: var(--iu-accent-ink);
}

.iu-switch:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}

.iu-switch--disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.iu-switch-row--sm .iu-switch-row__label {
  font-size: var(--iu-font-size-13);
}
.iu-switch--sm {
  width: 28px;
  height: 16px;
  border-radius: 8px;
}
.iu-switch--sm .iu-switch__thumb {
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
}
.iu-switch--sm.iu-switch--on .iu-switch__thumb {
  transform: translateX(12px);
}
</style>
