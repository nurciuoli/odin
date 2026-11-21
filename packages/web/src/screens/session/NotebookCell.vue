<script setup lang="ts">
// One notebook cell, drawn the way the thread draws a tool call: a quiet line saying what it is, the source, and its
// output joined underneath. A Markdown cell reads as prose until it is edited. The same cell serves a live notebook
// and a notebook file read from disk (`readonly`, no kernel).
import { computed, ref } from 'vue'
import type { NotebookCell, NotebookOutput as CellOutput } from '@odin/shared/notebooks'
import { IuButton } from '@/components/Button'
import { IuCodeEditor } from '@/components/CodeEditor'
import { IuIcon } from '@/components/Icon'
import { IuMarkdown } from '@/components/Markdown'
import { statusLabel, type Status } from '@/styles/status'
import NotebookOutput from './NotebookOutput.vue'

const props = withDefaults(
  defineProps<{
    cell: NotebookCell
    /** 1-based position, for labels. */
    number: number
    /** What to show under the source: the live outputs of a running cell, else the saved ones. */
    outputs: CellOutput[]
    /** A streamed reference uses its persisted output position, independent of displayed stream chunks. */
    outputIndexes?: (number | null)[]
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
    /** Where the cell is in its run: drawn as the rail by the source and said in words. */
    status?: Status
    /** How long the last run took, already formatted ("0.4s"). */
    duration?: string
    /** Why the last run failed, shown under the cell. */
    error?: string
    /** One quiet line under the source (no Python to run on). */
    note?: string
  }>(),
  {
    kernelId: undefined,
    outputIndexes: undefined,
    readonly: false,
    blocked: false,
    locked: false,
    detached: false,
    marked: false,
    status: 'idle',
    duration: '',
    error: '',
    note: '',
  },
)
const emit = defineEmits<{ run: []; remove: [] }>()
const source = defineModel<string>('source', { required: true })
// A Markdown cell opens as prose; an empty one has nothing to read, so it opens for writing.
const opensForWriting = () =>
  props.cell.kind === 'markdown' && !props.cell.source.trim() && !props.detached
const editing = ref(opensForWriting())
const prose = () => props.cell.kind === 'markdown' && !editing.value
const state = computed(() =>
  [props.status === 'idle' ? '' : statusLabel[props.status], props.duration]
    .filter(Boolean)
    .join(' · '),
)
</script>

<template>
  <article
    class="nb-cell"
    :class="[`nb-cell--${cell.kind}`, { 'nb-cell--prose': prose(), 'nb-cell--marked': marked }]"
    :aria-label="`Cell ${number}`"
    :data-cell="cell.id"
    :data-status="status"
    tabindex="-1"
  >
    <div class="nb-cell__gutter">
      <span v-if="cell.kind === 'code'" class="nb-cell__count"
        >[{{ status === 'running' ? '*' : (cell.executionCount ?? ' ') }}]</span
      >
    </div>
    <div class="nb-cell__body">
      <div class="nb-cell__meta">
        <!-- Code is the default and a rendered Markdown cell reads as prose, so only an open Markdown cell says what it is. -->
        <span v-if="cell.kind === 'markdown' && editing" class="nb-cell__kind">Markdown</span>
        <span v-if="state" class="nb-cell__state">{{ state }}</span>
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
            :key="output.type === 'reference' ? `${index}:${output.version ?? ''}` : index"
            :output="output"
            :index="outputIndexes?.[index] ?? index"
            :kernel-id="kernelId"
            :cell-id="cell.id"
          />
        </div>
      </div>
      <p v-if="note && !error && cell.kind === 'code'" class="nb-cell__note">{{ note }}</p>
      <p v-if="error" class="nb-cell__error" role="alert">{{ error }}</p>
    </div>
  </article>
</template>

<style>
.nb-cell {
  display: grid;
  grid-template-columns: 44px minmax(0, 1fr);
  min-width: 0;
  border-radius: var(--iu-radius-sm);
  outline: none;
}
.nb-cell--marked {
  outline: 1px solid var(--iu-accent-border);
  outline-offset: 4px;
  border-radius: var(--iu-radius-md);
}
.nb-cell__gutter {
  padding: 4px 12px 0 0;
  text-align: right;
  color: var(--iu-text-disabled);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  white-space: pre;
}
.nb-cell__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding-left: 12px;
  border-left: 2px solid var(--iu-border-quiet);
}
.nb-cell:hover .nb-cell__body,
.nb-cell:focus-within .nb-cell__body {
  border-left-color: var(--iu-border-strong);
}
.nb-cell--prose .nb-cell__body {
  border-left-color: transparent;
}
.nb-cell[data-status='running'] .nb-cell__body {
  border-left-color: var(--iu-accent);
}
.nb-cell[data-status='ok'] .nb-cell__body {
  border-left-color: var(--iu-positive);
}
.nb-cell[data-status='failed'] .nb-cell__body {
  border-left-color: var(--iu-danger);
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
.nb-cell__state {
  margin-left: auto;
}
.nb-cell[data-status='failed'] .nb-cell__state {
  color: var(--iu-danger);
}
.nb-cell__tools {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  opacity: 0;
}
.nb-cell__state + .nb-cell__tools {
  margin-left: 0;
}
/* Tools come up when the cell is pointed at or focused; they stay in the tab order, and show always on touch. */
.nb-cell:hover .nb-cell__tools,
.nb-cell:focus-within .nb-cell__tools {
  opacity: 1;
}
@media (hover: none) {
  .nb-cell__tools {
    opacity: 1;
  }
}
.nb-cell__card {
  min-width: 0;
}
.nb-cell__outputs {
  display: flex;
  flex-direction: column;
  margin-top: 8px;
  color: var(--iu-text-2);
}
.nb-cell__note,
.nb-cell__error {
  margin: 4px 0 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.nb-cell__note {
  color: var(--iu-text-muted);
}
.nb-cell__error {
  color: var(--iu-danger);
}
.nb-cell__prose {
  min-width: 0;
}
@media (prefers-reduced-motion: no-preference) {
  .nb-cell__tools {
    transition: opacity 160ms ease;
  }
}
</style>
