<script setup lang="ts">
// "Import a Claude Code plugin": a git address or a folder on this machine. Odin reads it and shows what it would add
// (members, hooks and commands with their exact text, warnings); nothing is written until you confirm.
import { computed, ref, watch } from 'vue'
import type { ImportPreview, PluginSource } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'
import SelectField from '@/screens/shared/SelectField.vue'
import PluginReview from './PluginReview.vue'

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ imported: [id: string] }>()

const api = useApi()
const type = ref<'git' | 'local'>('git')
const url = ref('')
const rev = ref('')
const path = ref('')
const id = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const preview = ref<ImportPreview | null>(null)

watch(
  open,
  isOpen => {
    if (!isOpen) return
    preview.value = null
    error.value = null
    busy.value = false
  },
  { immediate: true },
)

const source = computed<PluginSource | null>(() => {
  if (type.value === 'git') {
    const u = url.value.trim()
    return u
      ? { type: 'git', url: u, ...(rev.value.trim() ? { rev: rev.value.trim() } : {}) }
      : null
  }
  const p = path.value.trim()
  return p ? { type: 'local', path: p } : null
})

async function read() {
  if (!source.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    preview.value = await api.previewPluginImport({
      source: source.value,
      ...(id.value.trim() ? { id: id.value.trim() } : {}),
    })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function confirm() {
  if (!preview.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    const asset = await api.confirmPluginImport(preview.value.previewId)
    open.value = false
    emit('imported', asset.id)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" :size="preview ? 'lg' : 'md'">
    <template #header>
      <h2 class="import-plugin__title">Import a Claude Code plugin</h2>
    </template>
    <div v-if="!preview" class="import-plugin__form">
      <p class="import-plugin__note">
        Skills, subagents, commands (as skills), hooks and MCP servers are converted and kept inside
        the plugin. You review everything before it is written.
      </p>
      <SelectField
        v-model="type"
        label="Source"
        :options="[
          { id: 'git', label: 'A git address' },
          { id: 'local', label: 'A folder on this computer' },
        ]"
      />
      <template v-if="type === 'git'">
        <IuField
          v-model="url"
          label="Git address"
          mono
          placeholder="https://github.com/org/plugin.git"
        />
        <IuField v-model="rev" label="Branch, tag or commit (optional)" mono placeholder="main" />
      </template>
      <IuField
        v-else
        v-model="path"
        label="Folder"
        mono
        placeholder="/Users/you/plugins/release-helper"
      />
      <IuField v-model="id" label="Library id (optional)" mono placeholder="its name, as a slug" />
    </div>
    <PluginReview
      v-else
      :members="preview.members"
      :runs="preview.runs"
      :secrets="preview.secrets.map(name => ({ name }))"
      :warnings="preview.warnings"
    />
    <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="busy" @click="open = false"
        >Cancel</IuButton
      >
      <IuButton v-if="preview" variant="ghost" size="sm" :disabled="busy" @click="preview = null"
        >Back</IuButton
      >
      <IuButton v-if="preview" variant="primary" size="sm" :loading="busy" @click="confirm"
        >Import “{{ preview.name }}”</IuButton
      >
      <IuButton v-else variant="primary" size="sm" :loading="busy" :disabled="!source" @click="read"
        >Review</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.import-plugin__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.import-plugin__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.import-plugin__note {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
</style>
