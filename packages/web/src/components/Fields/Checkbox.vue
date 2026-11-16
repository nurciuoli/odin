<script setup lang="ts">
import { computed, useAttrs, useId, useTemplateRef, watchEffect } from 'vue'

// Native checkbox underneath (keyboard + a11y for free), custom box on top.
// `indeterminate` is display-only: the parent decides what a click does next.
// Pass `aria-label` for a label-less (bare) checkbox, e.g. in a table row.
defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    label?: string
    disabled?: boolean
    indeterminate?: boolean
  }>(),
  { disabled: false, indeterminate: false },
)

const model = defineModel<boolean>({ default: false })

const id = useId()
const attrs = useAttrs()
const rootAttrs = computed(() => ({ class: attrs.class, style: attrs.style }))
const inputAttrs = computed(() => {
  const { class: _c, style: _s, ...rest } = attrs
  return rest
})

const input = useTemplateRef<HTMLInputElement>('input')
watchEffect(() => {
  if (input.value) input.value.indeterminate = props.indeterminate
})

function toggle(e: Event) {
  model.value = (e.target as HTMLInputElement).checked
}
</script>

<template>
  <label
    :for="id"
    class="iu-checkbox"
    :class="{ 'iu-checkbox--disabled': disabled }"
    :data-state="indeterminate ? 'mixed' : model ? 'on' : 'off'"
    v-bind="rootAttrs"
  >
    <input
      :id="id"
      ref="input"
      type="checkbox"
      class="iu-checkbox__input"
      :checked="model"
      :disabled="disabled"
      v-bind="inputAttrs"
      @change="toggle"
    />
    <span class="iu-checkbox__box" aria-hidden="true">
      <svg class="iu-checkbox__svg" viewBox="0 0 14 14" width="14" height="14" fill="none">
        <path class="iu-checkbox__tick" d="M3.5 7.4 L6 9.9 L10.6 4.4" pathLength="1" />
        <path class="iu-checkbox__dash" d="M3.75 7 H10.25" pathLength="1" />
      </svg>
    </span>
    <span v-if="label || $slots.default" class="iu-checkbox__label"
      ><slot>{{ label }}</slot></span
    >
  </label>
</template>

<style>
.iu-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: var(--iu-font-size-14);
  color: var(--iu-text);
}

.iu-checkbox__input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.iu-checkbox__box {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  box-sizing: border-box;
  border-radius: var(--iu-radius-sm);
  border: 1px solid var(--iu-border);
  background: var(--iu-well);
  color: var(--iu-accent-ink);
  transition:
    background-color 0.08s linear,
    border-color 0.08s linear,
    box-shadow 0.08s linear;
}

/* Tick and dash draw in via stroke-dashoffset */
.iu-checkbox__svg {
  display: block;
  overflow: visible;
}
.iu-checkbox__tick,
.iu-checkbox__dash {
  stroke: currentColor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  transition: stroke-dashoffset 0.14s linear;
}
.iu-checkbox[data-state='on'] .iu-checkbox__tick,
.iu-checkbox[data-state='mixed'] .iu-checkbox__dash {
  stroke-dashoffset: 0;
}

.iu-checkbox__input:hover:not(:disabled) + .iu-checkbox__box {
  border-color: var(--iu-border-strong);
  box-shadow: 0 0 0 3px var(--iu-accent-wash);
}

.iu-checkbox[data-state='on'] .iu-checkbox__box,
.iu-checkbox[data-state='mixed'] .iu-checkbox__box {
  background: var(--iu-accent-fill);
  border-color: var(--iu-accent-fill);
}

.iu-checkbox__input:focus-visible + .iu-checkbox__box {
  outline: 1px solid var(--iu-accent);
  outline-offset: 2px;
}

.iu-checkbox--disabled {
  cursor: not-allowed;
  color: var(--iu-text-disabled);
}
.iu-checkbox--disabled .iu-checkbox__box {
  background: var(--iu-surface);
  border-color: var(--iu-hairline);
  box-shadow: none;
}
.iu-checkbox--disabled[data-state='on'] .iu-checkbox__box,
.iu-checkbox--disabled[data-state='mixed'] .iu-checkbox__box {
  background: var(--iu-border);
  border-color: var(--iu-border);
}

@media (prefers-reduced-motion: reduce) {
  .iu-checkbox__box,
  .iu-checkbox__tick,
  .iu-checkbox__dash {
    transition: none;
  }
}
</style>
