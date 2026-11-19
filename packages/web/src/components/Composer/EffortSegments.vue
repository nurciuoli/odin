<script setup lang="ts">
// One row of thin segments, one per effort level, filled left to right up to the current level, with the level's
// word on the right. Nothing selected (Auto) leaves every segment empty. A real radiogroup: arrow keys move the
// choice, and the control never takes focus by itself. Clicking the current level again goes back to Auto.
import { computed, ref } from 'vue'
import { effortTone } from './effortScale'

const props = withDefaults(
  defineProps<{
    levels: { id: string; label: string }[]
    disabled?: boolean
  }>(),
  { disabled: false },
)
const value = defineModel<string | null>({ default: null })

const group = ref<HTMLElement | null>(null)
const index = computed(() => props.levels.findIndex(l => l.id === value.value))
const tone = computed(() => effortTone(index.value, props.levels.length))
const word = computed(() => (index.value >= 0 ? props.levels[index.value]!.label : 'Auto'))
const tabbable = computed(() => Math.max(0, index.value))

function choose(i: number) {
  value.value = i === index.value ? null : (props.levels[i]?.id ?? null)
}

function onKeydown(e: KeyboardEvent, i: number) {
  const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
  if (e.key === 'Enter' || e.key === ' ') {
    // the button's own click does the choosing; the surrounding menu must not also activate its row
    e.stopPropagation()
    return
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    // vertical keys belong to the menu: hand it focus back
    group.value?.closest<HTMLElement>('[role="menu"]')?.focus({ preventScroll: true })
    return
  }
  if (!step) return
  e.preventDefault()
  e.stopPropagation()
  const next = i + step
  if (next < 0) value.value = null
  else if (next < props.levels.length) value.value = props.levels[next]!.id
  const target = Math.min(Math.max(next, 0), props.levels.length - 1)
  group.value?.querySelectorAll<HTMLElement>('[role="radio"]')[target]?.focus()
}
</script>

<template>
  <div class="iu-effort" :data-effort-tone="tone">
    <div ref="group" class="iu-effort__group" role="radiogroup" aria-label="Effort">
      <button
        v-for="(level, i) in levels"
        :key="level.id"
        type="button"
        role="radio"
        class="iu-effort__segment"
        :class="{ 'iu-effort__segment--on': i <= index }"
        :aria-checked="i === index"
        :aria-label="level.label"
        :tabindex="i === tabbable ? 0 : -1"
        :disabled="disabled"
        @click="choose(i)"
        @keydown="onKeydown($event, i)"
      />
    </div>
    <span class="iu-effort__label">{{ word }}</span>
  </div>
</template>

<style>
/* the colour of a level; shared by the segments, their label and the composer chip's effort word */
[data-effort-tone] {
  --iu-effort-color: var(--iu-text-muted);
}
[data-effort-tone='cool'] {
  --iu-effort-color: var(--iu-info);
}
[data-effort-tone='ok'] {
  --iu-effort-color: var(--iu-positive);
}
[data-effort-tone='warm'] {
  --iu-effort-color: var(--iu-warning);
}
[data-effort-tone='hot'] {
  --iu-effort-color: var(--iu-danger);
}

.iu-effort {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 2px 10px 8px 32px;
  color: var(--iu-effort-color);
}
.iu-effort__group {
  display: flex;
  flex: 1;
  gap: 4px;
}
.iu-effort__segment {
  position: relative;
  flex: 1;
  height: 4px;
  padding: 0;
  border: none;
  border-radius: var(--iu-radius-pill);
  background: var(--iu-border-strong);
  cursor: pointer;
}
/* a generous hit area around a thin bar */
.iu-effort__segment::before {
  content: '';
  position: absolute;
  inset: -10px -2px;
}
.iu-effort__segment--on {
  background: var(--iu-effort-color);
}
.iu-effort__segment:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.iu-effort__segment:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.iu-effort__label {
  min-width: 5ch;
  text-align: right;
  font-size: var(--iu-font-size-12);
  color: var(--iu-effort-color);
}
@media (prefers-reduced-motion: no-preference) {
  .iu-effort__segment,
  .iu-effort__label {
    transition:
      background-color var(--iu-dur) var(--iu-ease),
      color var(--iu-dur) var(--iu-ease);
  }
}
</style>
