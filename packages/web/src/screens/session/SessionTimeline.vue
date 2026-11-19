<script setup lang="ts">
// The session timeline (⌥T): one row per user message down the thread's side gutter, on the same trunk-and-fork
// graph as Background tasks. Moving through it scrolls the thread behind it; ↵ stays where you are, Esc goes back to
// where you were (SessionScreen keeps the scroll position). The selected step offers copying your prompt or Claude's
// reply. It takes focus when opened because the reader asked for it, and the screen gives focus back on close.
import { nextTick, onMounted, useTemplateRef, watch } from 'vue'
import { IuIcon } from '@/components/Icon'
import { stepClock, stepIndex, type TimelineStep } from './timeline'

const props = defineProps<{ steps: TimelineStep[] }>()
const selected = defineModel<number>({ required: true })
const emit = defineEmits<{
  commit: []
  cancel: []
  copy: [what: 'prompt' | 'reply', step: TimelineStep]
}>()

const root = useTemplateRef<HTMLElement>('root')
onMounted(() => root.value?.focus({ preventScroll: true }))
// keep the selected row in view when the list is longer than the gutter
watch(selected, async () => {
  await nextTick()
  root.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
})

function onKeydown(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const move = (d: number) => {
    e.preventDefault()
    selected.value = stepIndex(selected.value, d, props.steps.length)
  }
  switch (e.key) {
    case 'ArrowUp':
    case 'k':
      return move(-1)
    case 'ArrowDown':
    case 'j':
      return move(1)
    case 'Home':
      e.preventDefault()
      selected.value = 0
      return
    case 'End':
      e.preventDefault()
      selected.value = props.steps.length - 1
      return
    case 'Enter':
      e.preventDefault()
      return emit('commit')
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      return emit('cancel')
    case 'c':
      e.preventDefault()
      return emit('copy', 'prompt', props.steps[selected.value]!)
    case 'r':
      e.preventDefault()
      return emit('copy', 'reply', props.steps[selected.value]!)
  }
}
const GRAPH = { w: 44, h: 46, x: 8, y: 23 }
</script>

<template>
  <nav ref="root" class="timeline" tabindex="-1" aria-label="Session timeline" @keydown="onKeydown">
    <ol
      class="timeline__list"
      role="listbox"
      aria-label="Steps"
      :aria-activedescendant="`tl-${steps[selected]?.id}`"
    >
      <li
        v-for="(s, i) in steps"
        :id="`tl-${s.id}`"
        :key="s.id"
        role="option"
        class="timeline__row"
        :class="{ 'is-selected': i === selected }"
        :aria-selected="i === selected"
        @click="selected = i"
        @dblclick="emit('commit')"
      >
        <svg
          class="timeline__graph"
          :width="GRAPH.w"
          :height="GRAPH.h"
          :viewBox="`0 0 ${GRAPH.w} ${GRAPH.h}`"
          aria-hidden="true"
        >
          <line
            class="timeline__trunk"
            :x1="GRAPH.x"
            :x2="GRAPH.x"
            :y1="i === 0 ? GRAPH.y : 0"
            :y2="i === steps.length - 1 ? GRAPH.y : GRAPH.h"
          />
          <template v-if="s.agents">
            <path class="timeline__fork timeline__fork--agent" d="M8 23Q8 33 18 33H32" />
            <circle class="timeline__head timeline__head--agent" cx="34" cy="33" r="2.6" />
          </template>
          <template v-if="s.failed">
            <path class="timeline__fork timeline__fork--failed" d="M8 23Q8 13 18 13H32" />
            <rect
              class="timeline__head timeline__head--failed"
              x="31"
              y="10"
              width="6"
              height="6"
            />
          </template>
          <circle
            class="timeline__node"
            :cx="GRAPH.x"
            :cy="GRAPH.y"
            :r="i === selected ? 5.5 : 4"
          />
        </svg>
        <div class="timeline__body">
          <p class="timeline__prompt">{{ s.prompt }}</p>
          <p class="timeline__meta">
            <span class="timeline__sr"
              >Step {{ s.n }}{{ s.at ? `, ${stepClock(s.at)}` : '' }}.
            </span>
            <span v-if="s.failed" class="timeline__flag timeline__flag--failed"
              >{{ s.failed }} failed</span
            >
            <span v-if="s.agents" class="timeline__flag timeline__flag--agent">agent</span>
            <span v-if="s.files" class="timeline__flag"
              >{{ s.files }} file{{ s.files === 1 ? '' : 's' }}</span
            >
          </p>
          <div v-if="i === selected" class="timeline__acts">
            <button
              type="button"
              tabindex="-1"
              title="Copy your prompt (c)"
              @click.stop="emit('copy', 'prompt', s)"
            >
              <IuIcon name="copy" :size="14" />you<kbd>c</kbd>
            </button>
            <button
              type="button"
              tabindex="-1"
              title="Copy Claude's reply (r)"
              :disabled="!s.reply"
              @click.stop="emit('copy', 'reply', s)"
            >
              <IuIcon name="copy" :size="14" />Claude<kbd>r</kbd>
            </button>
            <button
              type="button"
              tabindex="-1"
              title="Stay here (Enter)"
              @click.stop="emit('commit')"
            >
              ↵
            </button>
          </div>
        </div>
      </li>
    </ol>
    <p class="timeline__keys" aria-hidden="true">↑↓ · ↵ · esc</p>
  </nav>
</template>

<style>
.timeline {
  position: absolute;
  z-index: 5;
  top: 12px;
  bottom: 0;
  left: 0;
  width: 330px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 12px 0 20px;
  box-sizing: border-box;
  background: linear-gradient(to right, var(--iu-ground) 55%, transparent);
  outline: none;
}
.timeline__list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  max-height: 100%;
  scrollbar-width: none;
}
.timeline__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 46px;
  cursor: pointer;
  opacity: 0.6;
  transition: opacity var(--iu-dur) var(--iu-ease);
}
.timeline__row:hover,
.timeline__row.is-selected {
  opacity: 1;
}
.timeline__graph {
  flex: none;
  margin-left: -8px;
  overflow: visible;
}
.timeline__trunk {
  stroke: var(--iu-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
}
.timeline__node {
  fill: var(--iu-ground);
  stroke: var(--iu-text-2);
  stroke-width: 2;
}
.is-selected .timeline__node {
  fill: var(--iu-text);
  stroke: var(--iu-text);
}
.timeline__fork {
  fill: none;
  stroke-width: 1.6;
  stroke-linecap: round;
}
.timeline__fork--agent {
  stroke: var(--iu-info);
  stroke-dasharray: 3 2;
}
.timeline__fork--failed {
  stroke: var(--iu-danger);
}
.timeline__head--agent {
  fill: var(--iu-info);
}
.timeline__head--failed {
  fill: var(--iu-danger);
}
.timeline__body {
  min-width: 0;
  padding: 4px 0;
}
.timeline__prompt {
  margin: 0;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13);
  line-height: var(--iu-leading-snug);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.is-selected .timeline__prompt {
  color: var(--iu-text);
}
.timeline__meta {
  margin: 0;
  display: flex;
  gap: 8px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11);
}
.timeline__meta:empty {
  display: none;
}
.timeline__flag--failed {
  color: var(--iu-danger);
}
.timeline__flag--agent {
  color: var(--iu-info);
}
.timeline__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.timeline__acts {
  display: flex;
  gap: 4px;
  margin-top: 5px;
}
.timeline__acts button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  line-height: 16px;
  color: var(--iu-text-muted);
  background: transparent;
  border: 1px solid var(--iu-hairline);
  border-radius: 5px;
  padding: 0 5px;
  cursor: pointer;
  font: inherit;
  font-size: var(--iu-font-size-11);
}
.timeline__acts button:hover:not(:disabled) {
  color: var(--iu-text);
  border-color: var(--iu-border);
}
.timeline__acts button:disabled {
  opacity: 0.5;
  cursor: default;
}
.timeline__acts button:focus-visible {
  outline: 2px solid var(--iu-info);
  outline-offset: 1px;
}
.timeline__acts kbd {
  color: var(--iu-text-disabled);
  font: inherit;
}
.timeline__keys {
  position: absolute;
  bottom: 14px;
  left: 20px;
  margin: 0;
  color: var(--iu-text-disabled);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10);
}
/* Where the thread leaves no gutter (a narrow window, or the details panel open), the timeline floats over it as a card. */
@container session-main (max-width: 1400px) {
  .timeline {
    top: 20px;
    bottom: auto;
    max-height: calc(100% - 140px);
    left: 12px;
    width: 300px;
    padding: 12px 12px 12px 20px;
    background: var(--iu-surface);
    border: 1px solid var(--iu-border);
    border-radius: var(--iu-radius-lg);
    box-shadow: var(--iu-shadow-popover);
    justify-content: flex-start;
  }
  .timeline__keys {
    position: static;
    margin-top: 8px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .timeline__row {
    transition: none;
  }
}
</style>
