<script setup lang="ts">
// One notebook cell, drawn the way the thread draws a tool call: a quiet line saying what it is, the source, and its
// output joined underneath. A Markdown cell reads as prose until it is edited. The same cell serves a live notebook
// and a notebook file read from disk (`readonly`, no kernel).
import { ref } from 'vue'
import type { NotebookCell, NotebookOutput as CellOutput } from '@odin/shared/notebooks'
import { IuButton } from '@/components/Button'
import { IuCodeEditor } from '@/components/CodeEditor'
import { IuIcon } from '@/components/Icon'
import { IuMarkdown } from '@/components/Markdown'
import NotebookOutput from './NotebookOutput.vue'

const props = withDefaults(
  defineProps<{
    cell: NotebookCell
    /** 1-based position, for labels. */
    number: number
    /** What to show under the source: the live outputs of a running cell, else the saved ones. */
    outputs: CellOutput[]
    kernelId?: string
    /** The source cannot be edited (JupyterLab owns the notebook, or this is a file on disk). */
    readonly?: boolean
    /** Run is unavailable right now. */
    blocked?: boolean
    /** Structure cannot change right now. */
    locked?: boolean
    /** No kernel behind it: nothing runs and nothing is removed. */
    detached?: boolean
    /** The thread pointed at this cell: marked for a moment. */
    marked?: boolean
  }>(),
  {
    kernelId: undefined,
    readonly: false,
    blocked: false,
    locked: false,
    detached: false,
    marked: false,
  },
)
const emit = defineEmits<{ run: []; remove: [] }>()
const source = defineModel<string>('source', { required: true })
// A Markdown cell opens as prose; an empty one has nothing to read, so it opens for writing.
const opensForWriting = () =>
  props.cell.kind === 'markdown' && !props.cell.source.trim() && !props.detached
const editing = ref(opensForWriting())
const prose = () => props.cell.kind === 'markdown' && !editing.value
</script>

<template>
  <article
    class="nb-cell"
    :class="[`nb-cell--${cell.kind}`, { 'nb-cell--prose': prose(), 'nb-cell--marked': marked }]"
    :aria-label="`Cell ${number}`"
    :data-cell="cell.id"
  >
    <div class="nb-cell__meta">
      <span v-if="cell.kind === 'code'" class="nb-cell__count"
        >[{{ cell.executionCount ?? ' ' }}]</span
      >
      <span>{{ cell.kind === 'code' ? 'Python' : 'Markdown' }}</span>
      <span class="nb-cell__tools">
        <IuButton
          v-if="cell.kind === 'markdown' && !detached"
          variant="ghost"
          size="sm"
          :disabled="readonly && !editing"
          :aria-pressed="editing"
          :aria-label="editing ? `Finish editing cell ${number}` : `Edit cell ${number}`"
          @click="editing = !editing"
          >{{ editing ? 'Done' : 'Edit' }}</IuButton
        >
        <IuButton
          v-if="!detached"
          variant="ghost"
          size="sm"
          icon-only
          :disabled="locked"
          :aria-label="`Remove cell ${number}`"
          :title="`Remove cell ${number}`"
          @click="emit('remove')"
        >
          <template #icon><IuIcon name="trash" :size="14" /></template>
        </IuButton>
        <IuButton
          v-if="cell.kind === 'code' && !detached"
          variant="secondary"
          size="sm"
          :disabled="blocked"
          :aria-label="`Run cell ${number}`"
          title="Run (Shift+Enter)"
          @click="emit('run')"
        >
          <template #icon><IuIcon name="play" :size="14" /></template>
          Run
        </IuButton>
      </span>
    </div>
    <IuMarkdown v-if="prose()" class="nb-cell__prose" :source="cell.source" />
    <div v-else class="nb-cell__card">
      <IuCodeEditor
        v-model="source"
        :label="`Cell ${number} source`"
        :language="cell.kind === 'code' ? 'python' : 'markdown'"
        :readonly="readonly"
        @run="cell.kind === 'code' && !detached && emit('run')"
      />
      <div v-if="outputs.length" class="nb-cell__outputs" :aria-label="`Cell ${number} output`">
        <NotebookOutput
          v-for="(output, index) in outputs"
          :key="index"
          :output="output"
          :index="index"
          :kernel-id="kernelId"
          :cell-id="cell.id"
        />
      </div>
    </div>
  </article>
</template>

<style>
.nb-cell {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  border-radius: var(--iu-radius-sm);
}
.nb-cell--marked {
  outline: 1px solid var(--iu-accent-border);
  outline-offset: 4px;
}
.nb-cell__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  color: var(--iu-text-muted);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
}
.nb-cell__count {
  color: var(--iu-text-2);
  white-space: pre;
}
.nb-cell__tools {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
/* Prose cells keep their tools out of the way until the cell is pointed at or focused; they stay in the tab order. */
.nb-cell--prose .nb-cell__meta {
  opacity: 0.55;
}
.nb-cell--prose:hover .nb-cell__meta,
.nb-cell--prose:focus-within .nb-cell__meta {
  opacity: 1;
}
.nb-cell__card {
  min-width: 0;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  overflow: hidden;
  background: var(--iu-ground);
}
.nb-cell__outputs {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--iu-border);
  background: var(--iu-well);
}
.nb-cell__outputs > * + * {
  border-top: 1px solid var(--iu-border-quiet);
}
.nb-cell__prose {
  min-width: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .nb-cell--prose .nb-cell__meta {
    transition: opacity 120ms ease;
  }
}
</style>
