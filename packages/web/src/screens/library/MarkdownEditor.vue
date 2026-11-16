<script setup lang="ts">
// The editor for the markdown kinds (agent, command, prompt, and a skill's SKILL.md): the frontmatter fields the
// kind has, then the body. It edits one file's text and emits the rebuilt text on every change.
import { computed, ref, watch } from 'vue'
import { IuField, IuTextarea } from '@/components/Fields'
import { IuBadge } from '@/components/Badge'
import { promptVariables } from '@odin/shared/library'
import { buildMarkdown, MARKDOWN_FIELDS, parseMarkdown } from './assetForm'

const VARIABLE_EXAMPLE = '{' + '{name}}'

const props = defineProps<{ kind: 'instruction' | 'agent' | 'command' | 'prompt' | 'skill' }>()
const text = defineModel<string>({ required: true })

const keys = computed(() =>
  props.kind === 'instruction'
    ? []
    : props.kind === 'skill'
      ? MARKDOWN_FIELDS.command
      : MARKDOWN_FIELDS[props.kind],
)
const LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  tools: 'Tools',
  model: 'Model',
}
const HINTS: Record<string, string> = {
  tools: 'Comma separated, e.g. Read, Grep, Glob. Empty means all tools.',
  model: 'An alias (sonnet, opus, haiku, inherit) or a model id.',
}

const parsed = parseMarkdown(text.value)
const fields = ref<Record<string, string>>({ ...parsed.fields })
const body = ref(parsed.body)
let built = text.value

// A change from outside (a version loaded, a save finished) replaces the form; our own echo does not.
watch(text, next => {
  if (next === built) return
  const p = parseMarkdown(next)
  fields.value = { ...p.fields }
  body.value = p.body
  built = next
})

function emitText() {
  const extra = Object.entries(fields.value).filter(([k]) => !keys.value.includes(k))
  built = buildMarkdown(
    [...keys.value.map((k): [string, string] => [k, fields.value[k] ?? '']), ...extra],
    body.value,
  )
  text.value = built
}

function setField(key: string, value: string) {
  fields.value[key] = value
  emitText()
}
function setBody(value: string) {
  body.value = value
  emitText()
}

const variables = computed(() => (props.kind === 'prompt' ? promptVariables(body.value) : []))
</script>

<template>
  <div class="md-editor">
    <div class="md-editor__fields">
      <IuField
        v-for="k in keys"
        :key="k"
        :label="LABELS[k] ?? k"
        :model-value="fields[k] ?? ''"
        :hint="HINTS[k]"
        :mono="k === 'tools' || k === 'model'"
        @update:model-value="setField(k, String($event))"
      />
    </div>
    <IuTextarea
      :model-value="body"
      :label="kind === 'prompt' ? 'Prompt' : kind === 'skill' ? 'Instructions' : 'Body'"
      :rows="16"
      mono
      @update:model-value="setBody"
    />
    <p v-if="kind === 'prompt'" class="md-editor__vars">
      <span>Variables</span>
      <template v-if="variables.length">
        <IuBadge v-for="v in variables" :key="v" variant="tag" size="xs">{{ v }}</IuBadge>
      </template>
      <span v-else class="md-editor__none">None. Write {{ VARIABLE_EXAMPLE }} to add one.</span>
    </p>
  </div>
</template>

<style>
.md-editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.md-editor__fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.md-editor__vars {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.md-editor__none {
  color: var(--iu-text-muted);
}
</style>
