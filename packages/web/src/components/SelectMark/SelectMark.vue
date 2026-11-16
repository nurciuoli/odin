<script setup lang="ts">
import { IuCheckbox } from '@/components/Fields'

// Thin controlled wrapper over IuCheckbox for places where the parent owns
// the state (select-all with a mixed state, list rows). `checked` in,
// `change` out — no v-model, no visible label.
defineProps<{
  checked?: boolean
  indeterminate?: boolean
  disabled?: boolean
  label?: string
}>()

defineEmits<{ change: [checked: boolean] }>()
</script>

<template>
  <IuCheckbox
    :model-value="checked"
    :indeterminate="indeterminate"
    :disabled="disabled"
    :aria-label="label"
    @update:model-value="$emit('change', $event)"
  />
</template>
