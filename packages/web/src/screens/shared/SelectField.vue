<script setup lang="ts">
// A labelled single choice: the library's IuSelect with a visible label, over { id, label } options.
import { computed, useId } from 'vue'
import { IuSelect } from '@/components/Select'

export interface Choice {
  id: string
  label: string
}

const props = defineProps<{
  label: string
  options: Choice[]
  placeholder?: string
  disabled?: boolean
}>()
const model = defineModel<string>({ default: '' })

const labelId = useId()
const selected = computed(() => props.options.filter(o => o.id === model.value))
function onSelected(next: Choice[]) {
  model.value = next[0]?.id ?? ''
}
</script>

<template>
  <div class="select-field">
    <span :id="labelId" class="select-field__label">{{ label }}</span>
    <IuSelect
      :options="options"
      :selected="selected"
      :placeholder="placeholder"
      :disabled="disabled"
      :aria-labelledby="labelId"
      @update:selected="onSelected"
    />
  </div>
</template>

<style>
.select-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.select-field__label {
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-2);
}
</style>
