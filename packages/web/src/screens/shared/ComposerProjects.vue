<script setup lang="ts">
import { computed } from 'vue'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import type { Choice } from './SelectField.vue'

const props = withDefaults(defineProps<{ options: Choice[]; disabled?: boolean }>(), {
  disabled: false,
})
const working = defineModel<string>({ default: '' })
const projects = defineModel<string[]>('projects', { default: () => [] })
const label = computed(() => {
  const title = props.options.find(p => p.id === working.value)?.label ?? 'Choose projects'
  return projects.value.length > 1 ? `${title} +${projects.value.length - 1}` : title
})
const items = computed<MenuItem[]>(() => [
  { type: 'label', label: 'Repositories available to this session' },
  ...props.options.map(p => ({
    type: 'check' as const,
    id: p.id,
    label: p.label,
    checked: projects.value.includes(p.id),
  })),
  { type: 'separator' },
  {
    id: 'working',
    label: 'Working repository',
    description: 'Runs here; new worktrees apply only to this repository',
    items: props.options
      .filter(p => projects.value.includes(p.id))
      .map(p => ({
        type: 'radio' as const,
        id: `working:${p.id}`,
        label: p.label,
        checked: p.id === working.value,
      })),
  },
])
function select(id: string) {
  if (id.startsWith('working:')) {
    working.value = id.slice(8)
    return
  }
  if (projects.value.includes(id)) {
    projects.value = projects.value.filter(p => p !== id)
    if (working.value === id) working.value = projects.value[0] ?? ''
  } else {
    projects.value = [...projects.value, id]
    if (!working.value) working.value = id
  }
}
</script>

<template>
  <IuMenu :items="items" placement="bottom-start" :close-on-select="false" fixed @select="select">
    <template #trigger="{ toggle, open }">
      <IuButton
        variant="ghost"
        size="sm"
        :aria-label="`Projects: ${label}`"
        aria-haspopup="menu"
        :aria-expanded="open"
        :disabled="disabled"
        @click="toggle"
      >
        <template #icon><IuIcon name="folder" :size="14" /></template>
        {{ label }}
        <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
      </IuButton>
    </template>
  </IuMenu>
</template>
