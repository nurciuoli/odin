<script setup lang="ts">
// The editor for the JSON kinds (template, MCP server, settings profile): a form for the spec, and the raw JSON as a
// fallback for anything the form doesn't cover (or when the JSON doesn't parse yet).
import { computed, ref } from 'vue'
import type { AssetKind } from '@odin/shared/api'
import { IuCallout } from '@/components/Callout'
import { IuTextarea } from '@/components/Fields'
import { IuTabs } from '@/components/Tabs'
import McpForm from './McpForm.vue'
import SettingsForm from './SettingsForm.vue'
import { parseJsonObject, specProblems, stringify, type JsonObject } from './assetForm'

const props = defineProps<{ kind: AssetKind }>()
const text = defineModel<string>({ required: true })

const parsed = computed(() => parseJsonObject(text.value))
const doc = computed<JsonObject>(() => ('value' in parsed.value ? parsed.value.value : {}))
const parseError = computed(() => ('error' in parsed.value ? parsed.value.error : null))
const problems = computed(() => (parseError.value ? [] : specProblems(props.kind, doc.value)))

const mode = ref<'form' | 'raw'>('form')
const active = computed({
  get: () => (parseError.value ? 'raw' : mode.value),
  set: v => (mode.value = v as 'form' | 'raw'),
})
const tabs = computed(() => [
  { id: 'form', label: 'Form', disabled: !!parseError.value },
  { id: 'raw', label: 'Raw JSON' },
])

function setDoc(next: JsonObject) {
  text.value = stringify(next)
}
</script>

<template>
  <div class="json-editor">
    <IuTabs v-model="active" :tabs="tabs" variant="segmented" :lazy="false">
      <template #panel:form>
        <div class="json-editor__panel">
          <McpForm v-if="kind === 'mcp'" :model-value="doc" @update:model-value="setDoc" />
          <SettingsForm v-else :model-value="doc" @update:model-value="setDoc" />
        </div>
      </template>
      <template #panel:raw>
        <div class="json-editor__panel">
          <IuTextarea v-model="text" label="Spec (JSON)" mono :rows="18" />
        </div>
      </template>
    </IuTabs>
    <IuCallout v-if="parseError" intent="danger" variant="inline" live>
      This isn't valid JSON yet: {{ parseError }}
    </IuCallout>
    <IuCallout v-else-if="problems.length" intent="warning" variant="inline">
      <ul class="json-editor__problems">
        <li v-for="p in problems" :key="p">{{ p }}</li>
      </ul>
    </IuCallout>
  </div>
</template>

<style>
.json-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.json-editor__panel {
  padding-top: 16px;
}
.json-editor__problems {
  margin: 0;
  padding-left: 18px;
}
</style>
