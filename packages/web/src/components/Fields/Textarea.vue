<script setup lang="ts">
import { computed, useId, useSlots } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    hint?: string
    error?: string
    size?: 'sm' | 'md' | 'lg'
    mono?: boolean
    disabled?: boolean
    rows?: number
    maxlength?: number
  }>(),
  { size: 'md', mono: false, disabled: false, rows: 4 },
)

const model = defineModel<string>({ default: '' })

const id = useId()
const slots = useSlots()
const msgId = computed(() => `${id}-msg`)
const describedBy = computed(() =>
  props.error || props.hint || props.maxlength ? msgId.value : undefined,
)
const length = computed(() => model.value.length)
const overLimit = computed(() => !!props.maxlength && length.value > props.maxlength)
</script>

<template>
  <div
    class="iu-field iu-field--textarea"
    :class="[`iu-field--${size}`, { 'iu-field--invalid': !!error }]"
  >
    <label :for="id" class="iu-field__label">{{ label }}</label>
    <div class="iu-field__box iu-field__box--textarea">
      <textarea
        :id="id"
        v-model="model"
        :rows="rows"
        :disabled="disabled"
        :maxlength="maxlength"
        :aria-invalid="!!error || undefined"
        :aria-describedby="describedBy"
        class="iu-field__textarea"
        :class="{ 'iu-field__textarea--mono': mono }"
      />
    </div>
    <div v-if="error || hint || slots.hint || maxlength" class="iu-field__msg-row" :id="msgId">
      <p v-if="error || hint || slots.hint" class="iu-field__msg">
        <slot name="hint">{{ error || hint }}</slot>
      </p>
      <span
        v-if="maxlength"
        class="iu-field__counter"
        :class="{ 'iu-field__counter--over': overLimit }"
      >
        {{ length }} / {{ maxlength }}
      </span>
    </div>
  </div>
</template>

<style>
/* textarea grows vertically instead of centering a single line of text */
.iu-field__box--textarea {
  align-items: stretch;
}
.iu-field__box--textarea .iu-field__textarea {
  resize: vertical;
  line-height: var(--iu-leading-relaxed);
  min-height: 4.8em;
}
</style>
