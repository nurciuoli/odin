<script setup lang="ts">
// Segmented control: a short, single-choice setting (a date range, a view) as a radiogroup. One tab stop; arrow
// keys move and select, Home/End jump. For switching panels of content use IuTabs instead.
import { nextTick, ref } from 'vue'

export interface SegmentedOption {
  value: string
  label: string
  disabled?: boolean
}

const props = defineProps<{
  options: SegmentedOption[]
  /** Names the group for assistive tech ("Range"). */
  label: string
}>()

const model = defineModel<string>({ required: true })
const buttons = ref<HTMLButtonElement[]>([])
const enabled = () => props.options.filter(o => !o.disabled)
// The tab stop is the selected option, or the first enabled one when the model matches nothing.
const stop = (o: SegmentedOption) =>
  o.value === model.value ||
  (!props.options.some(p => p.value === model.value) && o === enabled()[0])

function onKeydown(e: KeyboardEvent) {
  const list = enabled()
  if (!list.length) return
  const i = list.findIndex(o => o.value === model.value)
  const next = {
    ArrowRight: i + 1,
    ArrowDown: i + 1,
    ArrowLeft: i - 1,
    ArrowUp: i - 1,
    Home: 0,
    End: list.length - 1,
  }[e.key]
  if (next === undefined) return
  e.preventDefault()
  const target = list[(next + list.length) % list.length]!
  model.value = target.value
  void nextTick(() => buttons.value.find(b => b.dataset.value === target.value)?.focus())
}
</script>

<template>
  <div class="iu-segmented" role="radiogroup" :aria-label="label" @keydown="onKeydown">
    <button
      v-for="o in options"
      :key="o.value"
      ref="buttons"
      type="button"
      role="radio"
      class="iu-segmented__option"
      :data-value="o.value"
      :aria-checked="o.value === model"
      :disabled="o.disabled"
      :tabindex="stop(o) ? 0 : -1"
      @click="model = o.value"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style>
.iu-segmented {
  display: inline-flex;
  width: fit-content;
  padding: 3px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-well);
}
.iu-segmented__option {
  padding: 5px 12px;
  border: 0;
  border-radius: var(--iu-radius-md);
  background: none;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-muted);
  white-space: nowrap;
  cursor: pointer;
}
.iu-segmented__option:hover:not(:disabled) {
  color: var(--iu-text);
}
/* selected is a raised, outlined chip, not just a colour change */
.iu-segmented__option[aria-checked='true'] {
  background: var(--iu-raised);
  box-shadow: inset 0 0 0 1px var(--iu-border);
  color: var(--iu-text);
}
.iu-segmented__option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.iu-segmented__option:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
</style>
