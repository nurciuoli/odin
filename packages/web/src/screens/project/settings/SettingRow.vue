<script setup lang="ts">
// One row of the settings sheet: a label, the value, where the value came from. Click the value to edit it; Enter
// saves, Esc cancels, leaving the field saves. A refused save keeps the field open with the reason under the row.
import { computed, nextTick, ref, useId, useTemplateRef } from 'vue'

const props = withDefaults(
  defineProps<{
    label: string
    value: string
    mono?: boolean
    multiline?: boolean
    /** Shown in the value's place when it is empty. */
    placeholder?: string
    /** Right-aligned, quiet: "Odin", "PROJECT.md", "discovered". */
    origin?: string
    /** Not editable: just shows the value. */
    readonly?: boolean
    /** Returns the reason a value can't be saved, or undefined. */
    validate?: (value: string) => string | undefined
    /** Saves the new value; a rejection's message is shown and the row stays in edit mode. */
    save?: (value: string) => Promise<void>
  }>(),
  { mono: false, multiline: false, readonly: false },
)

const id = useId()
const editing = ref(false)
const draft = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const field = useTemplateRef<HTMLInputElement | HTMLTextAreaElement>('field')
const display = computed(() => props.value || props.placeholder || '')

async function start() {
  if (props.readonly || editing.value) return
  draft.value = props.value
  error.value = null
  editing.value = true
  await nextTick()
  field.value?.focus()
  field.value?.select()
}
function cancel() {
  editing.value = false
  error.value = null
}
async function commit() {
  if (!editing.value || busy.value) return
  const next = draft.value.trim()
  if (next === props.value.trim()) return cancel()
  const why = props.validate?.(next)
  if (why) {
    error.value = why
    return
  }
  busy.value = true
  try {
    await props.save?.(next)
    editing.value = false
    error.value = null
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    e.preventDefault()
    cancel()
  } else if (e.key === 'Enter' && !(props.multiline && e.shiftKey)) {
    e.preventDefault()
    void commit()
  }
}
</script>

<template>
  <div class="sheet-row" :class="{ 'sheet-row--editing': editing }">
    <label :for="id" class="sheet-row__label">{{ label }}</label>
    <div class="sheet-row__value">
      <textarea
        v-if="editing && multiline"
        :id="id"
        ref="field"
        v-model="draft"
        rows="2"
        class="sheet-row__input"
        :class="{ 'sheet-row__input--mono': mono }"
        :placeholder="placeholder"
        :aria-invalid="!!error"
        :aria-describedby="error ? `${id}-err` : undefined"
        :disabled="busy"
        @keydown="onKeydown"
        @blur="commit"
      />
      <input
        v-else-if="editing"
        :id="id"
        ref="field"
        v-model="draft"
        type="text"
        class="sheet-row__input"
        :class="{ 'sheet-row__input--mono': mono }"
        :placeholder="placeholder"
        :aria-invalid="!!error"
        :aria-describedby="error ? `${id}-err` : undefined"
        :disabled="busy"
        @keydown="onKeydown"
        @blur="commit"
      />
      <button
        v-else-if="!readonly"
        :id="id"
        type="button"
        class="sheet-row__button"
        :class="{
          'sheet-row__button--mono': mono,
          'sheet-row__button--empty': !value,
        }"
        :aria-label="`Edit ${label}`"
        @click="start"
      >
        {{ display }}
      </button>
      <span
        v-else
        :id="id"
        class="sheet-row__text"
        :class="{ 'sheet-row__button--mono': mono, 'sheet-row__button--empty': !value }"
        >{{ display }}</span
      >
      <p v-if="error" :id="`${id}-err`" class="sheet-row__error" role="alert">{{ error }}</p>
    </div>
    <div class="sheet-row__side">
      <slot name="side"
        ><span v-if="origin" class="sheet-row__origin">{{ origin }}</span></slot
      >
    </div>
  </div>
</template>

<style>
.sheet-row {
  display: grid;
  grid-template-columns: 150px minmax(0, 1fr) auto;
  gap: 12px;
  align-items: start;
  padding: 7px 0;
  border-top: 1px solid var(--iu-hairline);
}
.sheet-row__label {
  padding-top: 5px;
  color: var(--iu-text-2);
}
.sheet-row__value {
  min-width: 0;
}
.sheet-row__side {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
}
.sheet-row__origin {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.sheet-row__button,
.sheet-row__text {
  display: block;
  inline-size: 100%;
  min-height: 30px;
  padding: 4px 8px;
  margin: 0 -8px;
  border: 1px solid transparent;
  border-radius: var(--iu-radius-sm);
  background: none;
  color: var(--iu-text);
  font: inherit;
  text-align: start;
  overflow-wrap: anywhere;
}
.sheet-row__button {
  cursor: text;
}
.sheet-row__button:hover {
  border-color: var(--iu-border);
  background: var(--iu-surface-sunken);
}
.sheet-row__button:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 1px;
}
.sheet-row__button--mono,
.sheet-row__input--mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
}
.sheet-row__button--empty {
  color: var(--iu-text-muted);
}
.sheet-row__input {
  inline-size: 100%;
  padding: 4px 8px;
  margin: 0 -8px;
  border: 1px solid var(--iu-accent);
  border-radius: var(--iu-radius-sm);
  background: var(--iu-surface-sunken);
  color: var(--iu-text);
  font: inherit;
  resize: vertical;
}
.sheet-row__input:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px var(--iu-accent-wash);
}
.sheet-row__error {
  margin: 4px 0 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-danger);
}
@media (max-width: 640px) {
  .sheet-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 2px;
  }
  .sheet-row__label {
    padding-top: 0;
  }
}
</style>
