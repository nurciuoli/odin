<script setup lang="ts">
import { computed, useId, useSlots } from 'vue'
import IuTrace from '@/components/AgentTrace/AgentTrace.vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuSpinner from '@/components/Spinner/Spinner.vue'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import { statusLabel, type Status } from '@/styles/status'
import type { ToolCall } from '@/components/Chat/types'

const props = defineProps<{
  steps: ToolCall[]
  /** Replaces the summary line ("Worked for 2m 14s · 9 steps"); the status strip still shows. */
  label?: string
}>()

// The default slot, when given, renders the expanded body instead of the compact trace (richer step views).
const slots = useSlots()
const bodyId = useId()

// undefined = automatic. A user toggle (or a parent v-model) sets it and wins from then on.
// (the explicit undefined default stops Vue casting an absent boolean to false)
const open = defineModel<boolean | undefined>('open', { default: undefined })

const STRIP_MAX = 8

const autoOpen = computed(() =>
  props.steps.some(s => s.status === 'failed' || s.status === 'awaiting'),
)
const expanded = computed(() => open.value ?? autoOpen.value)

function toggle() {
  open.value = !expanded.value
}

const running = computed(() => props.steps.find(s => s.status === 'running'))

const totalMs = computed(() => {
  const timed = props.steps.filter(s => s.durationMs !== undefined)
  if (!timed.length) return undefined
  return timed.reduce((sum, s) => sum + (s.durationMs ?? 0), 0)
})

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// the same wording as the trace, so a group and its expanded rows never disagree
const srSummary = computed(() => {
  const counts = new Map<Status, number>()
  for (const s of props.steps) counts.set(s.status, (counts.get(s.status) ?? 0) + 1)
  return [...counts].map(([status, n]) => `${n} ${statusLabel[status]}`).join(', ')
})

const strip = computed(() => props.steps.slice(0, STRIP_MAX))
const overflow = computed(() => Math.max(0, props.steps.length - STRIP_MAX))
</script>

<template>
  <div class="iu-tool-group">
    <button
      type="button"
      class="iu-tool-group__head"
      :aria-expanded="expanded"
      :aria-controls="expanded ? bodyId : undefined"
      @click="toggle"
    >
      <IuIcon name="chevronRight" :size="14" class="iu-tool-group__chevron" />

      <span class="iu-tool-group__summary">
        <span v-if="label">{{ label }}</span>
        <template v-else-if="running">
          <IuSpinner :size="11" />
          <span>Running</span>
          <code class="iu-tool-group__tool">{{ running.tool }}</code>
          <code v-if="running.target" class="iu-tool-group__target">{{ running.target }}</code>
        </template>
        <template v-else-if="steps.length === 1">
          <code class="iu-tool-group__tool">{{ steps[0].tool }}</code>
          <code v-if="steps[0].target" class="iu-tool-group__target">{{ steps[0].target }}</code>
        </template>
        <span v-else>Used {{ steps.length }} tools</span>
      </span>

      <span v-if="totalMs !== undefined && !label" class="iu-tool-group__meta"
        >· {{ fmtDuration(totalMs) }}</span
      >

      <span class="iu-tool-group__strip">
        <span class="sr-only">{{ srSummary }}</span>
        <IuStatusDot v-for="s in strip" :key="s.id" :status="s.status" :size="6" decorative />
        <span v-if="overflow" class="iu-tool-group__more">+{{ overflow }}</span>
      </span>
    </button>

    <div v-if="expanded" :id="bodyId" class="iu-tool-group__body">
      <slot v-if="slots.default" />
      <IuTrace v-else :steps="steps" density="compact" auto-expand="failed" />
    </div>
  </div>
</template>

<style>
.iu-tool-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* the chevron sits on the prose edge: -8px margins cancel the head's own
   padding on both sides, so the hover fill bleeds evenly past the text column */
.iu-tool-group__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  margin: 0 -8px;
  padding: 0 8px;
  box-sizing: border-box;
  background: none;
  border: none;
  border-radius: var(--iu-radius-sm);
  color: var(--iu-text-2);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.iu-tool-group__head:hover {
  color: var(--iu-text);
  background: var(--iu-hover);
}

.iu-tool-group__head:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: 1px;
}

.iu-tool-group__chevron {
  flex: none;
  color: var(--iu-text-muted);
  transition: transform var(--iu-dur) var(--iu-ease);
}

.iu-tool-group__head[aria-expanded='true'] .iu-tool-group__chevron {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: reduce) {
  .iu-tool-group__chevron {
    transition: none;
  }
}

.iu-tool-group__summary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
}

.iu-tool-group__tool {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text);
  flex: none;
}

.iu-tool-group__target {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.iu-tool-group__meta {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  white-space: nowrap;
  flex: none;
}

/* pushes the status strip to the right edge */
.iu-tool-group__strip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  flex: none;
}

.iu-tool-group__more {
  margin-left: 3px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  color: var(--iu-text-muted);
}

.iu-tool-group__body {
  margin-left: 6px;
  padding: 6px 0 2px 12px;
  border-left: 1px solid var(--iu-hairline);
}
</style>
