<script setup lang="ts">
// "New <kind>": an id, a name and a description, then the editor opens on a starter file.
import { computed, ref, watch } from 'vue'
import type { AssetKind } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'
import { idError, slugify, starterFiles, kindNoun } from './assetForm'

const props = defineProps<{ kind: AssetKind; taken: string[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ created: [kind: AssetKind, id: string] }>()

const api = useApi()
const id = ref('')
const idTouched = ref(false)
const name = ref('')
const description = ref('')
const busy = ref(false)
const error = ref<string | null>(null)

watch(
  open,
  isOpen => {
    if (!isOpen) return
    id.value = ''
    idTouched.value = false
    name.value = ''
    description.value = ''
    error.value = null
  },
  { immediate: true },
)

// the id follows the name until you type one yourself
watch(name, n => {
  if (!idTouched.value) id.value = slugify(n)
})
const idProblem = computed(() => (id.value ? idError(id.value, props.taken) : null))
const valid = computed(() => !idError(id.value, props.taken))

function setId(value: string) {
  idTouched.value = true
  id.value = value
}

async function create() {
  if (!valid.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    await api.saveAsset(
      props.kind,
      id.value,
      starterFiles(props.kind, id.value, name.value.trim() || id.value, description.value.trim()),
    )
    open.value = false
    emit('created', props.kind, id.value)
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
      <h2 class="new-asset__title">New {{ kindNoun(kind) }}</h2>
    </template>
    <form class="new-asset__form" @submit.prevent="create">
      <IuField v-model="name" label="Name" />
      <IuField
        :model-value="id"
        label="Id"
        mono
        hint="The file name in the library. It can't change later."
        :error="idProblem ?? undefined"
        @update:model-value="setId(String($event))"
      />
      <IuField v-model="description" label="Description" />
      <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    </form>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="busy" @click="open = false"
        >Cancel</IuButton
      >
      <IuButton variant="primary" size="sm" :loading="busy" :disabled="!valid" @click="create"
        >Create</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.new-asset__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.new-asset__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
</style>
