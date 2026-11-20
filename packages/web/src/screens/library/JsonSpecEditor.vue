<script setup lang="ts">
// The editor for the JSON kinds (template, MCP server, settings profile): a form for the spec, and the raw JSON as a
// fallback for anything the form doesn't cover (or when the JSON doesn't parse yet).
import { computed, ref } from 'vue'
import type { AssetKind } from '@odin/shared/api'
import { IuButton } from '@/components/Button'
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
  <div class="json-editor" :class="{ 'json-editor--flat': kind === 'mcp' }">
    <div v-if="kind === 'mcp'" class="json-editor__switch">
      <IuButton
        type="button"
        size="sm"
        variant="ghost"
        :disabled="!!parseError && active === 'raw'"
        @click="active = active === 'form' ? 'raw' : 'form'"
      >
        {{ active === 'form' ? 'Edit JSON' : 'Back to form' }}
      </IuButton>
    </div>
    <IuTabs v-else v-model="active" :tabs="tabs" variant="segmented" :lazy="false">
      <template #panel:form>
        <div class="json-editor__panel">
          <SettingsForm :model-value="doc" @update:model-value="setDoc" />
        </div>
      </template>
      <template #panel:raw>
        <div class="json-editor__panel">
          <IuTextarea v-model="text" label="Spec (JSON)" mono :rows="18" />
        </div>
      </template>
    </IuTabs>
    <template v-if="kind === 'mcp'">
      <McpForm v-if="active === 'form'" :model-value="doc" @update:model-value="setDoc" />
      <IuTextarea v-else v-model="text" label="Spec (JSON)" mono :rows="12" />
    </template>
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
.json-editor--flat {
  gap: 8px;
}
.json-editor__switch {
  display: flex;
  justify-content: flex-end;
}
.json-editor__panel {
  padding-top: 16px;
}
.json-editor__problems {
  margin: 0;
  padding-left: 18px;
}
</style>
