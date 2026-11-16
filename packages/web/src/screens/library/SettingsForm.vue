<script setup lang="ts">
// The form for a settings profile: permission rules (one per line) and hooks as JSON.
import { ref } from 'vue'
import { IuCallout } from '@/components/Callout'
import { IuField, IuTextarea } from '@/components/Fields'
import SelectField from '@/screens/shared/SelectField.vue'
import { PERMISSION_MODES } from './assetForm'
import { parseLines, stringify, type JsonObject } from './assetForm'

const doc = defineModel<JsonObject>({ required: true })
const codexPolicy = () =>
  (doc.value.codex ?? {}) as { permissionMode?: string; instructions?: string }
function setCodexMode(mode: string) {
  const next = { ...doc.value }
  if (mode) next.codex = { ...codexPolicy(), permissionMode: mode }
  else delete next.codex
  doc.value = next
}

const str = (k: string) => (typeof doc.value[k] === 'string' ? (doc.value[k] as string) : '')
const permissions = () => (doc.value.permissions ?? {}) as Record<string, string[]>
const rules = (k: 'allow' | 'deny' | 'ask') => (permissions()[k] ?? []).join('\n')

function setRules(k: 'allow' | 'deny' | 'ask', text: string) {
  const next = { ...permissions(), [k]: parseLines(text) }
  if (!next[k].length) delete next[k]
  const merged: JsonObject = { ...doc.value, permissions: next }
  if (!Object.keys(next).length) delete merged.permissions
  doc.value = merged
}

const hooksText = ref(doc.value.hooks ? stringify(doc.value.hooks).trim() : '')
const hooksError = ref<string | null>(null)
function setHooks(text: string) {
  hooksText.value = text
  const merged: JsonObject = { ...doc.value }
  if (!text.trim()) {
    delete merged.hooks
    hooksError.value = null
  } else {
    try {
      const v: unknown = JSON.parse(text)
      if (typeof v !== 'object' || v === null || Array.isArray(v))
        throw new Error('Hooks are an object.')
      merged.hooks = v
      hooksError.value = null
    } catch (e) {
      hooksError.value = e instanceof Error ? e.message : String(e)
      return
    }
  }
  doc.value = merged
}
</script>

<template>
  <div class="settings-form">
    <div class="settings-form__row">
      <IuField
        label="Name"
        :model-value="str('name')"
        @update:model-value="doc = { ...doc, name: String($event) }"
      />
      <IuField
        label="Description"
        :model-value="str('description')"
        @update:model-value="doc = { ...doc, description: String($event) }"
      />
    </div>
    <div class="settings-form__rules">
      <IuTextarea
        label="Allow"
        mono
        :rows="5"
        hint="One rule per line, e.g. Bash(npm test:*)"
        :model-value="rules('allow')"
        @update:model-value="setRules('allow', $event)"
      />
      <IuTextarea
        label="Ask"
        mono
        :rows="5"
        :model-value="rules('ask')"
        @update:model-value="setRules('ask', $event)"
      />
      <IuTextarea
        label="Deny"
        mono
        :rows="5"
        :model-value="rules('deny')"
        @update:model-value="setRules('deny', $event)"
      />
    </div>
    <IuTextarea
      label="Hooks (JSON)"
      mono
      :rows="6"
      hint="Claude Code's hooks object. Empty for none."
      :model-value="hooksText"
      @update:model-value="setHooks"
    />
    <SelectField
      label="Codex policy"
      :model-value="codexPolicy().permissionMode ?? ''"
      :options="[
        { id: '', label: 'No native adaptation' },
        ...PERMISSION_MODES.filter(m => m !== 'auto').map(m => ({ id: m, label: m })),
      ]"
      @update:model-value="setCodexMode"
    />
    <IuTextarea
      v-if="codexPolicy().permissionMode"
      label="Codex instructions"
      :model-value="codexPolicy().instructions ?? ''"
      hint="Native guidance shared by sessions using this profile. The selected Codex policy replaces Claude rules and hooks for those sessions."
      @update:model-value="doc = { ...doc, codex: { ...codexPolicy(), instructions: $event } }"
    />
    <IuCallout v-if="hooksError" intent="danger" variant="inline" live
      >Hooks aren't valid JSON, so they aren't applied yet: {{ hooksError }}</IuCallout
    >
  </div>
</template>

<style>
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.settings-form__row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.settings-form__rules {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
</style>
