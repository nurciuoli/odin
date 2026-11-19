<script setup lang="ts">
// A message the harness put into the conversation that the user didn't type (an agent's report, another session's
// message, a notification): a collapsed line with its label, the body behind a native disclosure. Never "You".
import { computed } from 'vue'
import { IuIcon } from '@/components/Icon'
import { IuMarkdown } from '@/components/Markdown'
import { injectedLabel, type InjectedEntry } from './sessionView'

const props = withDefaults(defineProps<{ entry: InjectedEntry }>(), {})

const label = computed(() => injectedLabel(props.entry))
const icon = computed(() =>
  props.entry.source === 'agent' || props.entry.source === 'peer'
    ? 'message'
    : props.entry.source === 'scheduled'
      ? 'clock'
      : 'info',
)
</script>

<template>
  <details class="injected-notice" :data-source="entry.source">
    <summary class="injected-notice__summary">
      <IuIcon :name="icon" :size="14" />
      <span class="injected-notice__label">{{ label }}</span>
    </summary>
    <div class="injected-notice__body">
      <IuMarkdown v-if="entry.text" :source="entry.text" />
      <p v-else class="injected-notice__empty">No content.</p>
    </div>
  </details>
</template>

<style>
.injected-notice {
  margin: 4px 0;
  border-left: 2px solid var(--iu-border-quiet);
  padding-left: 10px;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
}
.injected-notice__summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  list-style: none;
  color: var(--iu-text-muted);
  font-weight: var(--iu-font-weight-medium);
}
.injected-notice__summary::-webkit-details-marker {
  display: none;
}
.injected-notice__summary::after {
  content: '>';
  color: var(--iu-text-muted);
}
details[open] > .injected-notice__summary::after {
  transform: rotate(90deg);
}
.injected-notice__summary:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.injected-notice__body {
  margin-top: 6px;
  color: var(--iu-text-2);
  line-height: var(--iu-leading-relaxed);
  overflow-wrap: anywhere;
}
.injected-notice__empty {
  margin: 0;
  color: var(--iu-text-muted);
}
</style>
