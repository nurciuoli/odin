<script setup lang="ts">
// One line of the side panel, in the thread's own grammar: a verb, a target, a quiet result. It is what a rail step's
// line reads like (components/Rail), so a file the agent edited or a notebook cell it ran looks the same beside the
// conversation as it does in it. Controls stay out of the way until the line is hovered or holds focus; on a device
// without hover they are always there.
import type { Status } from '@/styles/status'

withDefaults(
  defineProps<{
    verb?: string
    /** The result, a count or a time, at the far end. */
    meta?: string
    /** Tints the result, as the rail does: running, failed, awaiting. Words carry the status; colour only repeats it. */
    status?: Status
    /** The line itself is a button (open a file, unfold a body). */
    interactive?: boolean
    /** For a line that unfolds something: the state and the id of what it controls. */
    expanded?: boolean
    controls?: string
    /** Keep the controls visible (a draft with unsaved work, a cell being edited). */
    pinned?: boolean
    /** Sub-lines (a file's steps, a tree's children) sit one step quieter. */
    quiet?: boolean
    /** Plain sans text for the target (a note, a name) rather than a mono path or command. */
    prose?: boolean
  }>(),
  {
    verb: '',
    meta: '',
    status: undefined,
    interactive: false,
    expanded: undefined,
    controls: undefined,
    pinned: false,
    quiet: false,
    prose: false,
  },
)
const emit = defineEmits<{ activate: [] }>()
defineSlots<{ default?: () => unknown; actions?: () => unknown; lead?: () => unknown }>()
</script>

<template>
  <div
    class="panel-line"
    :class="{
      'panel-line--pinned': pinned,
      'panel-line--quiet': quiet,
      'panel-line--prose': prose,
    }"
    :data-status="status"
  >
    <component
      :is="interactive ? 'button' : 'div'"
      class="panel-line__main"
      :type="interactive ? 'button' : undefined"
      :aria-expanded="interactive ? expanded : undefined"
      :aria-controls="interactive ? controls : undefined"
      @click="interactive && emit('activate')"
    >
      <slot name="lead" />
      <span v-if="verb" class="panel-line__verb">{{ verb }}</span>
      <span class="panel-line__target"><slot /></span>
      <span v-if="meta" class="panel-line__meta">{{ meta }}</span>
    </component>
    <span v-if="$slots.actions" class="panel-line__actions"><slot name="actions" /></span>
  </div>
</template>

<style>
.panel-line {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  min-height: 28px;
}
.panel-line__main {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 28px;
  margin: 0;
  padding: 0 4px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  text-align: left;
}
button.panel-line__main {
  cursor: pointer;
}
/* as on the rail: a line you can act on brightens, it does not grow a box */
button.panel-line__main:hover .panel-line__target {
  color: var(--iu-text);
}
button.panel-line__main:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.panel-line__verb {
  flex: none;
  font-weight: var(--iu-font-weight-medium);
  white-space: nowrap;
}
.panel-line--quiet .panel-line__verb {
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-2);
}
.panel-line__target {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.panel-line--prose .panel-line__target {
  display: block;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.panel-line__meta {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  white-space: nowrap;
}
.panel-line[data-status='running'] .panel-line__meta {
  color: var(--iu-accent);
}
.panel-line[data-status='failed'] .panel-line__meta {
  color: var(--iu-danger);
}
.panel-line[data-status='awaiting'] .panel-line__meta {
  color: var(--iu-warning);
}

/* Controls lie over the end of the line, so showing them moves nothing. */
.panel-line__actions {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  padding-left: 12px;
  background: linear-gradient(to right, transparent, var(--iu-ground) 12px);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--iu-dur-fast) var(--iu-ease);
}
.panel-line:hover > .panel-line__actions,
.panel-line:focus-within > .panel-line__actions,
.panel-line--pinned > .panel-line__actions {
  opacity: 1;
  pointer-events: auto;
}
.panel-line--pinned > .panel-line__actions {
  position: static;
  padding-left: 4px;
  background: none;
}
@media (hover: none) {
  .panel-line > .panel-line__actions {
    position: static;
    padding-left: 4px;
    background: none;
    opacity: 1;
    pointer-events: auto;
  }
}
@media (prefers-reduced-motion: reduce) {
  .panel-line__actions {
    transition: none;
  }
}
</style>
