<script setup lang="ts">
// Add a secret, or replace the value of one. The value is sent once and never shown again.
import { computed, ref, watch } from 'vue'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'
import { secretNamePattern } from './mcpModel'

const props = defineProps<{
  /** Replace this secret; omitted: add a new one. */ existing?: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [name: string] }>()

const api = useApi()
const name = ref('')
const value = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

watch(
  open,
  isOpen => {
    if (!isOpen) return
    name.value = props.existing ?? ''
    value.value = ''
    error.value = null
  },
  { immediate: true },
)

const nameProblem = computed(() =>
  name.value && !secretNamePattern.test(name.value)
    ? 'Start with a letter; use letters, digits, _ and - (64 at most).'
    : undefined,
)
const valid = computed(() => secretNamePattern.test(name.value) && value.value !== '')

async function save() {
  if (!valid.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    await api.putSecret(name.value, value.value)
    value.value = ''
    open.value = false
    emit('saved', name.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" size="md">
    <template #header>
      <h2 class="secret-modal__title">
        {{ props.existing ? `Replace ${props.existing}` : 'Add a secret' }}
      </h2>
    </template>
    <form class="secret-modal__form" @submit.prevent="save">
      <IuField
        v-model="name"
        label="Name"
        mono
        :disabled="!!props.existing"
        hint="MCP servers refer to it as ${secret:NAME} in their arguments, environment, URL or headers."
        :error="nameProblem"
      />
      <IuField
        v-model="value"
        label="Value"
        type="password"
        mono
        hint="Stored in Odin's home folder and only used when a session starts. It is never shown again."
      />
      <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    </form>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="busy" @click="open = false"
        >Cancel</IuButton
      >
      <IuButton variant="primary" size="sm" :loading="busy" :disabled="!valid" @click="save"
        >Save</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.secret-modal__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.secret-modal__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
</style>
