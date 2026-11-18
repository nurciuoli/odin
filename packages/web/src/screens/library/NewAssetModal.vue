<script setup lang="ts">
// "New <kind>": an id, a name and a description, then the editor opens on a starter file.
import { computed, ref, watch } from 'vue'
import type { AssetKind } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import SelectField from '@/screens/shared/SelectField.vue'
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
const transport = ref<'stdio' | 'http' | 'sse'>('stdio')
const command = ref('')
const url = ref('')
const TRANSPORTS = [
  { id: 'stdio', label: 'Local command — Odin starts it on this machine' },
  { id: 'http', label: 'Remote URL (streamable HTTP)' },
  { id: 'sse', label: 'Remote URL (SSE, older servers)' },
]
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
    transport.value = 'stdio'
    command.value = ''
    url.value = ''
    error.value = null
  },
  { immediate: true },
)

// the id follows the name until you type one yourself
watch(name, n => {
  if (!idTouched.value) id.value = slugify(n)
})
const idProblem = computed(() => (id.value ? idError(id.value, props.taken) : null))
const specReady = computed(() =>
  props.kind !== 'mcp'
    ? true
    : transport.value === 'stdio'
      ? !!command.value.trim()
      : /^https?:\/\/\S+$/.test(url.value.trim()),
)
const valid = computed(() => !idError(id.value, props.taken) && specReady.value)

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
      starterFiles(props.kind, id.value, name.value.trim() || id.value, description.value.trim(), {
        type: transport.value,
        command: command.value,
        url: url.value,
      }),
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
      <IuField
        v-model="description"
        label="Description"
        :hint="
          kind === 'mcp'
            ? 'Optional. What the server gives an agent.'
            : 'Optional. Shown in the library list.'
        "
      />
      <template v-if="kind === 'mcp'">
        <SelectField v-model="transport" label="How does it run?" :options="TRANSPORTS" />
        <IuField
          v-if="transport === 'stdio'"
          v-model="command"
          label="Command"
          mono
          placeholder="npx -y @modelcontextprotocol/server-filesystem"
          hint="What to run, including its arguments. Add environment variables and secrets after creating it."
        />
        <IuField
          v-else
          v-model="url"
          label="URL"
          mono
          placeholder="https://example.com/mcp"
          hint="The server's address. Add headers after creating it."
          :error="url && !specReady ? 'Enter a full http(s) URL.' : undefined"
        />
      </template>
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
