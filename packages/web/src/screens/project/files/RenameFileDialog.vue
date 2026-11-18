<script setup lang="ts">
// Rename one file or folder in place. The server has the last word on clashes (409).
import { computed, ref, watch } from 'vue'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'
import { nameProblem } from './files'

const props = defineProps<{ project: string; path: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ renamed: [from: string, to: string] }>()

const api = useApi()
const current = computed(() => props.path.split('/').pop() ?? '')
const name = ref('')
const busy = ref(false)
const error = ref('')
const problem = computed(() => (name.value === current.value ? '' : nameProblem(name.value)))

watch(open, v => {
  if (v) {
    name.value = current.value
    error.value = ''
  }
})

async function submit() {
  if (problem.value || !name.value.trim() || name.value === current.value) return
  busy.value = true
  error.value = ''
  try {
    const { path } = await api.renameProjectFile(props.project, props.path, name.value.trim())
    open.value = false
    emit('renamed', props.path, path)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" size="sm">
    <template #header>
      <h2 class="files__dialog-h">Rename “{{ current }}”</h2>
    </template>
    <form id="files-rename" class="files__dialog-form" @submit.prevent="submit">
      <IuField v-model="name" label="Name" mono :error="problem || undefined" />
      <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    </form>
    <template #footer>
      <IuButton variant="ghost" @click="open = false">Cancel</IuButton>
      <IuButton
        variant="primary"
        type="submit"
        form="files-rename"
        :loading="busy"
        :disabled="!!problem || !name.trim() || name === current"
        >Rename</IuButton
      >
    </template>
  </IuDialog>
</template>
