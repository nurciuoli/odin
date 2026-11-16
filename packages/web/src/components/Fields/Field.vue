<script setup lang="ts">
import { computed, useId, useSlots } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    modelValue?: string | number
    hint?: string
    error?: string
    size?: 'sm' | 'md' | 'lg'
    mono?: boolean
    disabled?: boolean
    placeholder?: string
    /** native input type */
    type?: 'text' | 'search' | 'email' | 'url' | 'tel' | 'password' | 'number'
    /** keep the label for assistive tech but don't render it visibly */
    hideLabel?: boolean
    /** borderless until hovered or focused, for dense settings-style rows */
    quiet?: boolean
    /** text alignment inside the input */
    align?: 'start' | 'end'
  }>(),
  {
    size: 'md',
    mono: false,
    disabled: false,
    type: 'text',
    hideLabel: false,
    quiet: false,
    align: 'start',
  },
)

defineEmits<{ 'update:modelValue': [string | number] }>()

const id = useId()
const slots = useSlots()
const describedBy = computed(() => (props.error || props.hint ? `${id}-msg` : undefined))
</script>

<template>
  <div
    class="iu-field"
    :class="[
      `iu-field--${size}`,
      { 'iu-field--invalid': !!error, 'iu-field--quiet': quiet, 'iu-field--end': align === 'end' },
    ]"
  >
    <label :for="id" class="iu-field__label" :class="{ 'iu-field__label--hidden': hideLabel }">{{
      label
    }}</label>
    <div class="iu-field__box">
      <slot name="prefix" />
      <input
        :id="id"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        :aria-invalid="!!error || undefined"
        :aria-describedby="describedBy"
        :class="{ 'iu-field__input--mono': mono }"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <slot name="suffix" />
    </div>
    <p v-if="error || hint || slots.hint" :id="`${id}-msg`" class="iu-field__msg">
      <slot name="hint">{{ error || hint }}</slot>
    </p>
  </div>
</template>

<style>
/* Shared by every Fields/* component — Textarea reuses these class names
   directly since the whole library shares one global stylesheet. */
.iu-field {
  /* anchors the visually hidden label to the field, not to whatever positioned ancestor (or the page) is above */
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
}

.iu-field__label {
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-2);
}
/* visually hidden, still announced */
.iu-field__label--hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

.iu-field__box {
  display: flex;
  align-items: center;
  border-radius: var(--iu-radius-md);
  border: 1px solid var(--iu-border);
  background: var(--iu-well);
  overflow: hidden;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease;
}

.iu-field__box:focus-within {
  border-color: var(--iu-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--iu-accent) 20%, transparent);
}

/* the control itself (input, textarea) */
.iu-field__box input,
.iu-field__box textarea,
.iu-field__textarea {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  color: var(--iu-text);
  font: inherit;
  font-family: var(--iu-font-sans);
  padding: 10px 12px;
  font-size: var(--iu-font-size-13);
}

.iu-field__box input::placeholder,
.iu-field__box textarea::placeholder {
  color: var(--iu-text-muted);
}

.iu-field__input--mono,
.iu-field__textarea--mono {
  font-family: var(--iu-font-mono) !important;
}

/* sizes */
.iu-field--sm .iu-field__box {
  border-radius: var(--iu-radius-sm);
}
.iu-field--sm .iu-field__box input,
.iu-field--sm .iu-field__box textarea {
  font-size: var(--iu-font-size-12);
  padding: 6px 10px;
}

.iu-field--lg .iu-field__box {
  border-radius: var(--iu-radius-lg);
}
.iu-field--lg .iu-field__box input,
.iu-field--lg .iu-field__box textarea {
  font-size: var(--iu-font-size-14);
  padding: 13px 14px;
}

/* prefix / suffix slot content — plain affix (e.g. "$") on the left,
   chip-style affix (e.g. a unit label) on the right, matching the mockup */
.iu-field__box > :not(input):not(textarea) {
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}
.iu-field__box > :not(input):not(textarea):last-child {
  align-self: stretch;
  border-left: 1px solid var(--iu-hairline);
  background: var(--iu-surface);
}
.iu-field__box > input:not(:first-child),
.iu-field__box > textarea:not(:first-child) {
  padding-left: 0;
}
.iu-field__box > input:not(:last-child),
.iu-field__box > textarea:not(:last-child) {
  padding-right: 0;
}

/* invalid */
.iu-field--invalid .iu-field__box {
  border-color: var(--iu-danger);
}
.iu-field--invalid .iu-field__msg {
  color: var(--iu-danger);
}

/* disabled — the native attribute is the only signal available on the
   given markup, so it drives the surrounding chrome via :has() */
.iu-field:has(input:disabled) .iu-field__label,
.iu-field:has(textarea:disabled) .iu-field__label {
  color: var(--iu-text-disabled);
}
.iu-field:has(input:disabled) .iu-field__box,
.iu-field:has(textarea:disabled) .iu-field__box {
  background: var(--iu-surface);
  border-color: var(--iu-hairline);
}
.iu-field__box input:disabled,
.iu-field__box textarea:disabled {
  color: var(--iu-text-disabled);
  cursor: not-allowed;
}

/* hint / error message row */
.iu-field__msg-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.iu-field__msg {
  margin: 0;
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text-muted);
}
.iu-field__counter {
  flex-shrink: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.iu-field__counter--over {
  color: var(--iu-danger);
}

/* quiet: no chrome until hover; the accent border and well background appear on focus */
.iu-field--quiet .iu-field__box {
  border-color: transparent;
  background: transparent;
  border-radius: var(--iu-radius-sm);
}
.iu-field--quiet .iu-field__box:hover {
  border-color: var(--iu-hairline);
}
.iu-field--quiet .iu-field__box:focus-within {
  border-color: var(--iu-accent);
  background: var(--iu-well);
  box-shadow: none;
}
.iu-field--quiet .iu-field__box input {
  font-size: var(--iu-font-size-13);
  padding: 5px 8px;
}
.iu-field--quiet.iu-field--invalid .iu-field__box {
  border-color: var(--iu-danger);
}
.iu-field--end .iu-field__box input {
  text-align: right;
}
</style>
