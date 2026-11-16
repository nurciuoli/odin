<script setup lang="ts">
import { computed } from 'vue'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import type { Choice } from './SelectField.vue'

const props = withDefaults(
  defineProps<{ label: string; options: Choice[]; disabled?: boolean }>(),
  { disabled: false },
)
const value = defineModel<string>({ default: '' })
const current = computed(() => props.options.find(o => o.id === value.value)?.label ?? props.label)
const items = computed<MenuItem[]>(() =>
  props.options.map(o => ({
    type: 'radio',
    id: o.id,
    label: o.label,
    checked: o.id === value.value,
  })),
)
</script>

<template>
  <IuMenu :items="items" placement="top-start" fixed @select="value = $event">
    <template #trigger="{ toggle, open }">
      <IuButton
        variant="ghost"
        size="sm"
        :aria-label="`${label}: ${current}`"
        aria-haspopup="menu"
        :aria-expanded="open"
        :disabled="disabled"
        @click="toggle"
      >
        {{ current }}
        <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
      </IuButton>
    </template>
  </IuMenu>
</template>
