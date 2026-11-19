<script setup lang="ts">
import { computed, useId } from 'vue'

const props = withDefaults(
  defineProps<{
    label?: string
    value: string | number
    name?: string
    disabled?: boolean
  }>(),
  { disabled: false },
)

// Multiple IuRadio siblings share one v-model: each receives the same
// `modelValue`, compares it against its own `value`, and on click emits
// its own `value` back up — the standard native-radio v-model pattern.
const model = defineModel<string | number | undefined>()

const id = useId()
const checked = computed(() => model.value === props.value)

function select() {
  if (!props.disabled) model.value = props.value
}
</script>

<template>
  <label :for="id" class="iu-radio" :class="{ 'iu-radio--disabled': disabled }">
    <input
      :id="id"
      type="radio"
      class="iu-radio__input"
      :name="name"
      :checked="checked"
      :disabled="disabled"
      @change="select"
    />
    <span class="iu-radio__dot" />
    <span v-if="label || $slots.default" class="iu-radio__label"
      ><slot>{{ label }}</slot></span
    >
  </label>
</template>

<style>
.iu-radio {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: var(--iu-font-size-14);
  color: var(--iu-text);
}

.iu-radio__input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.iu-radio__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--iu-border);
  transition: border-color 0.12s ease;
}
.iu-radio__dot::after {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--iu-accent);
  transform: scale(0);
  transition: transform 0.12s ease;
}

.iu-radio__input:checked + .iu-radio__dot {
  border-color: var(--iu-accent);
}
.iu-radio__input:checked + .iu-radio__dot::after {
  transform: scale(1);
}

.iu-radio__input:focus-visible + .iu-radio__dot {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}

.iu-radio--disabled {
  cursor: not-allowed;
  color: var(--iu-text-disabled);
}
.iu-radio--disabled .iu-radio__dot {
  border-color: var(--iu-hairline);
}
.iu-radio--disabled .iu-radio__input:checked + .iu-radio__dot {
  border-color: var(--iu-border);
}
.iu-radio--disabled .iu-radio__input:checked + .iu-radio__dot::after {
  background: var(--iu-text-disabled);
}
</style>
