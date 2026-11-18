<script setup lang="ts">
// "Export as a Claude Code plugin": writes a folder others can install without Odin. Secrets stay as placeholders and
// OAuth settings are dropped; what a Claude Code plugin can't hold is listed.
import { ref, watch } from 'vue'
import type { ExportResult } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'
import { plural } from '@/screens/shared/format'

const props = defineProps<{ id: string; name: string }>()
const open = defineModel<boolean>('open', { required: true })

const api = useApi()
const path = ref('')
const busy = ref(false)
const error = ref<string | null>(null)
const result = ref<ExportResult | null>(null)

watch(
  open,
  isOpen => {
    if (!isOpen) return
    result.value = null
    error.value = null
  },
  { immediate: true },
)

async function run() {
  if (!path.value.trim() || busy.value) return
  busy.value = true
  error.value = null
  try {
    result.value = await api.exportPlugin(props.id, path.value.trim())
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
      <h2 class="export-plugin__title">Export “{{ name }}”</h2>
    </template>
    <form v-if="!result" class="export-plugin__body" @submit.prevent="run">
      <p class="export-plugin__note">
        Writes a Claude Code plugin folder: skills, subagents, hooks and MCP servers, with included
        library assets at their current version.
      </p>
      <IuField
        v-model="path"
        label="New folder (absolute path)"
        mono
        placeholder="/Users/you/plugins/release-helper"
      />
    </form>
    <div v-else class="export-plugin__body">
      <IuCallout intent="positive" variant="inline">
        Wrote {{ plural(result.files.length, 'file') }} to <code>{{ result.path }}</code
        >.
      </IuCallout>
      <IuCallout
        v-if="result.skipped.length"
        intent="warning"
        variant="inline"
        title="Not exported"
      >
        <ul class="export-plugin__list">
          <li v-for="s in result.skipped" :key="`${s.kind}/${s.id}`">
            <code>{{ s.kind }}/{{ s.id }}</code
            >: {{ s.reason }}
          </li>
        </ul>
      </IuCallout>
      <IuCallout v-if="result.notes.length" intent="info" variant="inline" title="Worth knowing">
        <ul class="export-plugin__list">
          <li v-for="n in result.notes" :key="n">{{ n }}</li>
        </ul>
      </IuCallout>
    </div>
    <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="busy" @click="open = false">{{
        result ? 'Done' : 'Cancel'
      }}</IuButton>
      <IuButton
        v-if="!result"
        variant="primary"
        size="sm"
        :loading="busy"
        :disabled="!path.trim()"
        @click="run"
        >Export</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.export-plugin__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.export-plugin__body {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.export-plugin__note {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.export-plugin__list {
  margin: 0;
  padding-left: 18px;
}
</style>
