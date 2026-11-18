<script setup lang="ts">
// A skill is a folder: SKILL.md plus any other files. A file list on the left, the selected file's editor on the
// right (SKILL.md gets the frontmatter fields). A plugin is edited the same way, with plugin.json as its entry.
import { computed, ref } from 'vue'
import type { AssetFiles } from '@odin/shared/api'
import { IuButton } from '@/components/Button'
import { IuField, IuTextarea } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import MarkdownEditor from './MarkdownEditor.vue'

const props = withDefaults(defineProps<{ entry?: string; noun?: string }>(), {
  entry: 'SKILL.md',
  noun: 'skill',
})
const ENTRY = computed(() => props.entry)
const MAX_FILES = 64

const files = defineModel<AssetFiles>({ required: true })

const names = computed(() =>
  Object.keys(files.value).sort((a, b) => (a === ENTRY.value ? -1 : a.localeCompare(b))),
)
const selected = ref(names.value[0] ?? ENTRY.value)
const current = computed(() =>
  selected.value in files.value ? selected.value : (names.value[0] ?? ENTRY.value),
)

const adding = ref(false)
const newName = ref('')
const nameError = computed(() => {
  const n = newName.value.trim()
  if (!n) return ''
  if (n.startsWith('/') || n.split('/').some(p => p === '..' || p === ''))
    return 'Use a relative path without “..”.'
  if (n in files.value) return 'That file already exists.'
  if (names.value.length >= MAX_FILES) return `A ${props.noun} can have up to ${MAX_FILES} files.`
  return ''
})

function setText(name: string, text: string) {
  files.value = { ...files.value, [name]: text }
}
function addFile() {
  const n = newName.value.trim()
  if (!n || nameError.value) return
  files.value = { ...files.value, [n]: '' }
  selected.value = n
  newName.value = ''
  adding.value = false
}
function removeFile(name: string) {
  const { [name]: _gone, ...rest } = files.value
  files.value = rest
  selected.value = ENTRY.value
}
</script>

<template>
  <div class="skill-editor">
    <nav class="skill-editor__files" :aria-label="`${props.noun} files`">
      <ul>
        <li v-for="n in names" :key="n">
          <button
            type="button"
            class="skill-editor__file"
            :aria-current="n === current ? 'true' : undefined"
            @click="selected = n"
          >
            <IuIcon name="file" :size="14" />
            <span>{{ n }}</span>
          </button>
        </li>
      </ul>
      <form v-if="adding" class="skill-editor__add" @submit.prevent="addFile">
        <IuField
          v-model="newName"
          label="File path"
          size="sm"
          mono
          placeholder="notes/checklist.md"
          :error="nameError || undefined"
        />
        <div class="skill-editor__add-actions">
          <IuButton
            size="sm"
            variant="primary"
            type="submit"
            :disabled="!newName.trim() || !!nameError"
            >Add</IuButton
          >
          <IuButton size="sm" variant="ghost" @click="adding = false">Cancel</IuButton>
        </div>
      </form>
      <IuButton v-else size="sm" variant="secondary" @click="adding = true">Add file</IuButton>
    </nav>

    <div class="skill-editor__pane">
      <MarkdownEditor
        v-if="current === ENTRY && ENTRY === 'SKILL.md'"
        kind="skill"
        :model-value="files[ENTRY] ?? ''"
        @update:model-value="setText(ENTRY, $event)"
      />
      <template v-else>
        <div class="skill-editor__bar">
          <code>{{ current }}</code>
          <IuButton size="sm" variant="ghost" @click="removeFile(current)">Remove file</IuButton>
        </div>
        <IuTextarea
          :model-value="files[current] ?? ''"
          :label="current"
          :rows="16"
          mono
          @update:model-value="setText(current, $event)"
        />
      </template>
    </div>
  </div>
</template>

<style>
.skill-editor {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.skill-editor__files {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.skill-editor__files ul {
  list-style: none;
  margin: 0;
  padding: 0;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.skill-editor__file {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text-2);
  font: inherit;
  font-size: var(--iu-font-size-13);
  text-align: start;
  cursor: pointer;
}
.skill-editor__file span {
  min-width: 0;
  overflow-wrap: anywhere;
}
.skill-editor__file:hover {
  background: var(--iu-hover);
}
.skill-editor__file[aria-current='true'] {
  background: var(--iu-accent-wash);
  color: var(--iu-text);
}
.skill-editor__file:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: 2px;
}
.skill-editor__add {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
}
.skill-editor__add-actions {
  display: flex;
  gap: 6px;
}
.skill-editor__pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.skill-editor__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--iu-font-size-13);
}
@media (max-width: 720px) {
  .skill-editor {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
