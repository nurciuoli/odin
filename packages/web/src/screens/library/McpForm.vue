<script setup lang="ts">
// The form for an MCP server spec: a local command or a remote URL.
import { computed } from 'vue'
import { IuField, IuTextarea } from '@/components/Fields'
import SelectField from '@/screens/shared/SelectField.vue'
import { parseLines, pairsText, parsePairs, type JsonObject } from './assetForm'

const doc = defineModel<JsonObject>({ required: true })

const TYPES = [
  { id: 'stdio', label: 'Local command (stdio)' },
  { id: 'http', label: 'Remote (http)' },
  { id: 'sse', label: 'Remote (sse)' },
]
const str = (k: string) => (typeof doc.value[k] === 'string' ? (doc.value[k] as string) : '')
const type = computed(() =>
  doc.value.type === 'http' || doc.value.type === 'sse' ? doc.value.type : 'stdio',
)
const remote = computed(() => type.value !== 'stdio')
const args = computed(() => (Array.isArray(doc.value.args) ? doc.value.args.join('\n') : ''))
const map = (k: string, sep: string) =>
  pairsText(doc.value[k] as Record<string, string> | undefined, sep)

function patch(next: JsonObject) {
  const merged: JsonObject = { ...doc.value, ...next }
  for (const [k, v] of Object.entries(merged)) {
    if (v === '' || (Array.isArray(v) && !v.length)) delete merged[k]
    else if (v && typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)
      delete merged[k]
  }
  doc.value = merged
}
function setType(next: string) {
  // the other transport's fields go away so the saved spec stays valid
  const { command: _c, args: _a, env: _e, url: _u, headers: _h, ...rest } = doc.value
  doc.value =
    next === 'stdio' ? { ...rest, type: 'stdio', command: '' } : { ...rest, type: next, url: '' }
}
</script>

<template>
  <div class="mcp-form">
    <div class="mcp-form__row">
      <IuField
        label="Name"
        :model-value="str('name')"
        @update:model-value="patch({ name: String($event) })"
      />
      <IuField
        label="Description"
        :model-value="str('description')"
        @update:model-value="patch({ description: String($event) })"
      />
    </div>
    <div class="mcp-form__row">
      <SelectField
        label="Transport"
        :options="TYPES"
        :model-value="type"
        @update:model-value="setType"
      />
      <IuField
        v-if="remote"
        label="URL"
        mono
        :model-value="str('url')"
        hint="Saving checks whether this server needs sign-in."
        :error="!str('url').trim() ? 'A remote server needs a URL.' : undefined"
        @update:model-value="patch({ url: String($event) })"
      />
      <IuField
        v-else
        label="Command"
        mono
        :model-value="str('command')"
        :error="!str('command').trim() ? 'A stdio server needs a command.' : undefined"
        @update:model-value="patch({ command: String($event) })"
      />
    </div>
    <template v-if="!remote">
      <div class="mcp-form__row">
        <IuTextarea
          label="Arguments"
          mono
          :rows="2"
          hint="One per line."
          :model-value="args"
          @update:model-value="patch({ args: parseLines($event) })"
        />
        <IuTextarea
          label="Environment"
          mono
          :rows="2"
          hint="KEY=value, one per line."
          :model-value="map('env', '=')"
          @update:model-value="patch({ env: parsePairs($event, '=') })"
        />
      </div>
    </template>
    <IuTextarea
      v-else
      class="mcp-form__headers"
      label="Headers"
      mono
      :rows="2"
      hint="Name: value, one per line. Leave empty when the server signs you in."
      :model-value="map('headers', ': ')"
      @update:model-value="patch({ headers: parsePairs($event, ':') })"
    />
  </div>
</template>

<style>
.mcp-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mcp-form__row {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.mcp-form :deep(.iu-field__textarea) {
  min-height: 2.6em;
}
</style>
