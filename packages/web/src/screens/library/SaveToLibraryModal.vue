<script setup lang="ts">
// Save reusable task text as a skill. Runtime configuration belongs to the session.
import { computed, ref, watch } from 'vue'
import type { AssetKind } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'
import { firstMessage, idError, slugify, skillFromSession, type SessionSource } from './assetForm'

const props = defineProps<{ session: SessionSource }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [kind: AssetKind, id: string] }>()

const api = useApi()
const kind = ref<'skill'>('skill')
const name = ref('')
const id = ref('')
const idTouched = ref(false)
const description = ref('')
const taken = ref<Record<string, string[]>>({ skill: [] })
const busy = ref(false)
const error = ref<string | null>(null)

const message = computed(() => firstMessage(props.session))

watch(
  open,
  async isOpen => {
    if (!isOpen) return
    kind.value = 'skill'
    name.value = props.session.title
    id.value = slugify(props.session.title)
    idTouched.value = false
    description.value = ''
    error.value = null
    try {
      const all = await api.listLibrary()
      taken.value = { skill: all.filter(a => a.kind === 'skill').map(a => a.id) }
    } catch {
      // the save itself reports a clash if there is one
    }
  },
  { immediate: true },
)
watch(name, n => {
  if (!idTouched.value) id.value = slugify(n)
})

const idProblem = computed(() => (id.value ? idError(id.value, taken.value[kind.value]) : null))
const problem = computed(() => {
  if (!message.value) return 'This session has no first message to save.'
  if (!name.value.trim()) return 'Give it a name.'
  return idError(id.value, taken.value[kind.value])
})

function setId(value: string) {
  idTouched.value = true
  id.value = value
}

async function save() {
  if (problem.value || busy.value) return
  busy.value = true
  error.value = null
  const make = skillFromSession
  try {
    await api.saveAsset(
      kind.value,
      id.value,
      make(props.session, id.value, name.value.trim(), description.value.trim()),
    )
    open.value = false
    emit('saved', kind.value, id.value)
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
      <h2 class="save-lib__title">Save to library</h2>
    </template>
    <form class="save-lib__form" @submit.prevent="save">
      <p class="save-lib__note">
        Save the first message as a reusable skill. Review and generalize its instructions in the
        library before installing it into a project.
      </p>
      <IuField v-model="name" label="Name" />
      <IuField
        :model-value="id"
        label="Id"
        mono
        :error="idProblem ?? undefined"
        @update:model-value="setId(String($event))"
      />
      <IuField v-model="description" label="Description" />
      <blockquote v-if="message" class="save-lib__preview">{{ message }}</blockquote>
      <IuCallout v-else intent="warning" variant="inline">{{ problem }}</IuCallout>
      <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    </form>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="busy" @click="open = false"
        >Cancel</IuButton
      >
      <IuButton variant="primary" size="sm" :loading="busy" :disabled="!!problem" @click="save"
        >Save</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.save-lib__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.save-lib__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.save-lib__note {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.save-lib__preview {
  margin: 0;
  max-height: 140px;
  overflow: auto;
  padding: 8px 12px;
  border-left: 2px solid var(--iu-border-strong);
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
