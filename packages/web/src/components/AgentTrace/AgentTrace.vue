<script setup lang="ts">
import { nextTick, ref, useSlots, watch } from 'vue'
import IuBadge from '@/components/Badge/Badge.vue'
import IuCodeBlock from '@/components/CodeBlock/CodeBlock.vue'
import IuDiff from '@/components/CodeBlock/Diff.vue'
import type { DiffHunk } from '@/components/CodeBlock/Diff.vue'
import IuSpinner from '@/components/Spinner/Spinner.vue'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import { statusIntent, statusLabel, worstStatus, type Status } from '@/styles/status'

// the template renders nested steps as <IuTrace> — the name makes that self-reference resolve
defineOptions({ name: 'IuTrace' })

export type StepStatus = Status

export interface TraceStep {
  id: string
  tool: string
  target?: string // path, query, command — the one-line subject
  status: Status
  summary?: string // 'Read 412 lines'
  durationMs?: number
  tokens?: number
  error?: string
  input?: unknown
  result?: unknown
  diff?: DiffHunk[]
  children?: TraceStep[] // a group
}

const props = withDefaults(
  defineProps<{
    steps: TraceStep[]
    autoExpand?: 'failed' | 'none' | 'all'
    follow?: boolean
    density?: 'compact' | 'comfortable'
    // undefined: no cap, the parent scrolls. Set: the trace is its own scroller.
    maxHeight?: string
  }>(),
  { autoExpand: 'failed', follow: true, density: 'comfortable' },
)

const slots = useSlots()

// only steps with something to show can expand; the rest are plain text heads
function expandable(s: TraceStep): boolean {
  return (
    s.input != null ||
    s.result != null ||
    s.error != null ||
    (s.diff?.length ?? 0) > 0 ||
    Boolean(slots[`payload:${s.tool}`])
  )
}

// explicit user toggles win over the autoExpand default
const overrides = ref(new Map<string, boolean>())
function isOpen(s: TraceStep): boolean {
  if (!expandable(s)) return false
  if (overrides.value.has(s.id)) return overrides.value.get(s.id)!
  // failures expand themselves; successes stay shut so a long run stays skimmable
  return props.autoExpand === 'all' || (props.autoExpand === 'failed' && s.status === 'failed')
}
function toggle(s: TraceStep) {
  if (!expandable(s)) return
  overrides.value.set(s.id, !isOpen(s))
}

// a group inherits its worst child state
function rollup(s: TraceStep): Status {
  if (!s.children?.length) return s.status
  return worstStatus(s.children.map(rollup))
}

function asCode(v: unknown): string {
  return typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? '')
}

function fmtDuration(ms?: number): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function fmtTokens(n: number): string {
  return n < 1000 ? `${n} tok` : `${(n / 1000).toFixed(1)}k tok`
}

function meta(s: TraceStep): string {
  return [fmtDuration(s.durationMs), s.tokens !== undefined ? fmtTokens(s.tokens) : '']
    .filter(Boolean)
    .join(' · ')
}

// auto-follow only while the user is already pinned to the bottom of our own scroller
const root = ref<HTMLElement | null>(null)
const atBottom = ref(true)
function onScroll(e: Event) {
  const el = e.target as HTMLElement
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch(
  () => [
    props.steps.length,
    props.steps.length ? rollup(props.steps[props.steps.length - 1]) : undefined,
  ],
  async () => {
    if (!props.follow || !props.maxHeight || !atBottom.value) return
    await nextTick()
    const el = root.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { deep: true },
)
</script>

<template>
  <ol
    ref="root"
    class="iu-trace"
    :class="[`iu-trace--${density}`, { 'iu-trace--scroll': maxHeight }]"
    :style="maxHeight ? { maxHeight } : undefined"
    :tabindex="maxHeight ? 0 : undefined"
    @scroll="onScroll"
  >
    <li v-for="s in steps" :key="s.id" class="iu-trace__step" :data-status="rollup(s)">
      <span class="iu-trace__rail" aria-hidden="true">
        <span class="iu-trace__node">
          <IuSpinner v-if="rollup(s) === 'running'" :size="11" />
          <IuStatusDot v-else :status="rollup(s)" :size="9" decorative />
        </span>
        <span class="iu-trace__line" />
      </span>

      <div class="iu-trace__body">
        <component
          :is="expandable(s) ? 'button' : 'span'"
          class="iu-trace__head"
          :class="{ 'iu-trace__head--toggle': expandable(s) }"
          :type="expandable(s) ? 'button' : undefined"
          :aria-expanded="expandable(s) ? isOpen(s) : undefined"
          @click="toggle(s)"
        >
          <slot name="step" :step="s">
            <code class="iu-trace__tool">{{ s.tool }}</code>
            <code v-if="s.target" class="iu-trace__target">{{ s.target }}</code>
            <IuBadge v-if="s.status !== 'ok'" :intent="statusIntent[s.status]" size="xs">
              {{ statusLabel[s.status] }}
            </IuBadge>
            <span class="iu-trace__meta">{{ meta(s) }}</span>
          </slot>
        </component>

        <p v-if="s.summary && !isOpen(s)" class="iu-trace__summary">{{ s.summary }}</p>

        <div v-if="isOpen(s)" class="iu-trace__payload">
          <slot :name="`payload:${s.tool}`" :step="s">
            <IuDiff v-if="s.diff?.length" :hunks="s.diff" />
            <IuCodeBlock v-if="s.input != null" :code="asCode(s.input)" language="input" />
            <IuCodeBlock v-if="s.result != null" :code="asCode(s.result)" language="result" wrap />
            <IuCodeBlock
              v-if="s.error != null"
              :code="asCode(s.error)"
              language="error"
              intent="danger"
              wrap
            />
          </slot>
        </div>

        <IuTrace
          v-if="s.children"
          :steps="s.children"
          :auto-expand="autoExpand"
          :density="density"
        />
      </div>
    </li>
  </ol>
</template>

<style>
.iu-trace {
  list-style: none;
  margin: 0;
  padding: 0;
  font-family: var(--iu-font-sans);
  display: flex;
  flex-direction: column;
}

/* only a capped trace scrolls itself; uncapped, the parent owns the scroll */
.iu-trace--scroll {
  overflow-y: auto;
  overscroll-behavior: contain;
}

.iu-trace--scroll:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: 1px;
}

.iu-trace--comfortable {
  font-size: var(--iu-font-size-13);
}

.iu-trace--compact {
  font-size: var(--iu-font-size-12);
}

.iu-trace__step {
  display: flex;
  gap: 14px;
  position: relative;
}

.iu-trace__rail {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 20px;
  flex: 0 0 auto;
  padding-top: 4px;
}

/* a fixed box so the dot and the spinner share one centre line */
.iu-trace__node {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 11px;
  height: 11px;
  flex: 0 0 auto;
}

.iu-trace__line {
  width: 1px;
  flex: 1;
  min-height: 22px;
  background: var(--iu-border);
}

.iu-trace__step:last-child .iu-trace__line {
  background: var(--iu-hairline);
}

.iu-trace__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 16px;
}

.iu-trace__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  text-align: left;
  font-family: var(--iu-font-mono);
  color: var(--iu-text);
  font-size: inherit;
}

.iu-trace__head--toggle {
  cursor: pointer;
}

.iu-trace__head--toggle:hover {
  color: var(--iu-accent);
}

.iu-trace__head:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: 2px;
  border-radius: 2px;
}

.iu-trace__tool {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
}

.iu-trace__target {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.iu-trace__meta {
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  margin-left: auto;
  white-space: nowrap;
}

.iu-trace__summary {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
  padding-top: 3px;
}

.iu-trace__payload {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 8px;
  min-width: 0;
}

.iu-trace--compact .iu-trace__step {
  gap: 9px;
}

.iu-trace--compact .iu-trace__rail {
  width: 18px;
}

.iu-trace--compact .iu-trace__body {
  padding-bottom: 0;
  gap: 4px;
}

.iu-trace--compact .iu-trace__head {
  font-size: var(--iu-font-size-12);
  gap: 9px;
}

.iu-trace--compact .iu-trace__tool {
  font-size: var(--iu-font-size-12);
}

.iu-trace--compact .iu-trace__target {
  font-size: var(--iu-font-size-11);
}
</style>
