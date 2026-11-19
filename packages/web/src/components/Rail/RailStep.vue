<script setup lang="ts">
// One step on the rail: a node on the spine, a line (verb, target, meta), a live note under it while it runs, an
// expandable body and, for an agent, a nested rail of its own steps.
import { computed, inject, nextTick, onMounted, ref, useId, watch } from 'vue'
import IuFlock from '@/components/Spinner/Flock.vue'
import IuFilePath from '@/components/FilePath/FilePath.vue'
import { RAIL_KEY, formatElapsed } from './context'
import type { RailStepView } from './types'

defineOptions({ name: 'IuRailStep' })

const props = defineProps<{ step: RailStepView }>()
defineSlots<{
  actions?: (p: { step: RailStepView }) => unknown
  body?: (p: { step: RailStepView }) => unknown
  after?: (p: { step: RailStepView }) => unknown
}>()

const ctx = inject(RAIL_KEY, null)
const bodyId = `${useId()}-body`

// a step is "live" (present-tense verb) while it runs or waits on someone
const live = computed(() => props.step.status === 'running' || props.step.status === 'awaiting')
const running = computed(() => props.step.status === 'running')
const children = computed(() => props.step.children ?? [])
const hasBody = computed(() => props.step.hasBody !== false)
const expandable = computed(() => hasBody.value || children.value.length > 0)

// failed and awaiting steps open on their own
const defaultOpen = computed(
  () => props.step.status === 'failed' || props.step.status === 'awaiting',
)
const override = ref<boolean | null>(null)
const open = computed(() => expandable.value && (override.value ?? defaultOpen.value))
function toggle() {
  override.value = !open.value
}
// bodies mount on first open (and stay, so folding can animate)
const rendered = ref(open.value)
watch(open, v => {
  if (v) rendered.value = true
})

const animate = computed(() => !!ctx && !ctx.initial.has(props.step.id))

const meta = computed(() => {
  const s = props.step
  if (running.value && s.startedAt !== undefined && ctx?.now.value !== undefined)
    return formatElapsed(ctx.now.value - s.startedAt)
  return s.meta ?? ''
})

const noteOpen = computed(() => running.value && !!props.step.note)
// keep the last note while it folds away
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const lastNote = ref(props.step.note ?? '')
watch(
  () => props.step.note,
  v => {
    if (v) lastNote.value = v
  },
)

// the tense roll: both verbs are in the DOM; the box's width follows the active one
const liveEl = ref<HTMLElement>()
const doneEl = ref<HTMLElement>()
const widths = ref<{ live: number; done: number }>({ live: 0, done: 0 })
function measure() {
  widths.value = { live: liveEl.value?.offsetWidth ?? 0, done: doneEl.value?.offsetWidth ?? 0 }
}
onMounted(() => {
  measure()
  void document.fonts?.ready.then(measure)
})
watch(
  () => [props.step.verb.live, props.step.verb.done],
  () => void nextTick(measure),
)
const verbStyle = computed(() => {
  const w = live.value ? widths.value.live : widths.value.done
  return w > 0 ? { width: `${w}px` } : undefined
})
</script>

<template>
  <div
    class="iu-rail__step"
    :class="`iu-rail__step--${step.kind}`"
    :data-status="step.status"
    :data-live="live"
    :data-animate="animate || undefined"
  >
    <div class="iu-rail__step-in">
      <span class="iu-rail__node" data-node aria-hidden="true" />
      <span v-if="step.kind === 'thinking' && running" class="iu-rail__flock" aria-hidden="true"
        ><IuFlock size="sm"
      /></span>

      <div class="iu-rail__row">
        <component
          :is="expandable ? 'button' : 'div'"
          class="iu-rail__line"
          :type="expandable ? 'button' : undefined"
          :aria-expanded="expandable ? open : undefined"
          :aria-controls="expandable ? bodyId : undefined"
          @click="expandable && toggle()"
        >
          <span class="iu-rail__verb" :style="verbStyle"
            ><span
              ><b ref="liveEl" :aria-hidden="!live">{{ step.verb.live }}</b
              ><b ref="doneEl" :aria-hidden="live">{{ step.verb.done }}</b></span
            ></span
          >
          <span v-if="step.path || step.target" class="iu-rail__target">
            <IuFilePath v-if="step.path" :path="step.path" :root="ctx?.root.value" />
            <template v-else>{{ step.target }}</template>
          </span>
          <span v-else class="iu-rail__target" />
          <span class="iu-rail__meta">{{ meta }}</span>
        </component>
        <slot name="actions" :step="step" />
      </div>

      <div class="iu-rail__fold" :data-shut="!noteOpen">
        <div>
          <div class="iu-rail__note" :data-kind="step.kind">{{ lastNote }}</div>
        </div>
      </div>

      <div v-if="hasBody && rendered" :id="bodyId" class="iu-rail__fold" :data-shut="!open">
        <div :inert="!open || undefined">
          <div class="iu-rail__body"><slot name="body" :step="step" /></div>
        </div>
      </div>

      <div v-if="children.length" class="iu-rail__fold" :data-shut="!open">
        <div :inert="!open || undefined">
          <div class="iu-rail__kids">
            <IuRailStep v-for="c in children" :key="c.id" :step="c">
              <template #actions="slotProps"><slot name="actions" v-bind="slotProps" /></template>
              <template #body="slotProps"><slot name="body" v-bind="slotProps" /></template>
              <template #after="slotProps"><slot name="after" v-bind="slotProps" /></template>
            </IuRailStep>
          </div>
        </div>
      </div>

      <slot name="after" :step="step" />
    </div>
  </div>
</template>

<style>
/* unfurl: the step is a one-row grid so height can animate to auto */
.iu-rail__step {
  display: grid;
  grid-template-rows: 1fr;
}
.iu-rail__step[data-animate] {
  animation: iu-rail-unfurl var(--iu-dur-unfurl) var(--iu-ease) both;
}
.iu-rail__step-in {
  position: relative;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  padding: 0 0 9px 26px;
}
@keyframes iu-rail-unfurl {
  from {
    grid-template-rows: 0fr;
    opacity: 0;
    clip-path: inset(0 100% 0 0);
  }
  to {
    grid-template-rows: 1fr;
    opacity: 1;
    clip-path: inset(0 0 0 0);
  }
}

/* node: the shape carries the kind, so status is never colour-only */
.iu-rail__node {
  position: absolute;
  left: 6px;
  top: 7px;
  box-sizing: border-box;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--iu-ground);
  border: 1.5px solid var(--iu-border-strong);
  transition:
    background var(--iu-dur-roll) var(--iu-ease),
    border-color var(--iu-dur-roll) var(--iu-ease),
    opacity var(--iu-dur) var(--iu-ease);
}
.iu-rail__step--thinking > .iu-rail__step-in > .iu-rail__node {
  border-radius: var(--iu-radius-xs);
  transform: rotate(45deg);
}
.iu-rail__step--agent > .iu-rail__step-in > .iu-rail__node {
  border-radius: 2px;
  width: 9px;
  height: 9px;
  left: 5px;
  top: 6px;
}
.iu-rail__step[data-status='ok'] > .iu-rail__step-in > .iu-rail__node,
.iu-rail__step[data-status='cancelled'] > .iu-rail__step-in > .iu-rail__node,
.iu-rail__step[data-status='idle'] > .iu-rail__step-in > .iu-rail__node {
  background: var(--iu-border-strong);
}
.iu-rail__step[data-status='failed'] > .iu-rail__step-in > .iu-rail__node {
  background: var(--iu-danger);
  border-color: var(--iu-danger);
}
.iu-rail__step[data-status='running'] > .iu-rail__step-in > .iu-rail__node {
  border-color: var(--iu-accent);
  animation: iu-rail-pulse var(--iu-dur-run) linear infinite;
}
.iu-rail__step[data-status='awaiting'] > .iu-rail__step-in > .iu-rail__node {
  border-color: var(--iu-warning);
  animation: iu-rail-breathe var(--iu-dur-breathe) var(--iu-ease-breathe) infinite;
}
.iu-rail__step--thinking[data-status='running'] > .iu-rail__step-in > .iu-rail__node {
  opacity: 0;
  animation: none;
}
.iu-rail__flock {
  position: absolute;
  left: -4px;
  top: 2px;
  display: inline-flex;
}
.iu-rail__flock .iu-flock--sm {
  margin: 0;
  /* the small flock sits where the node would */
  transform: scale(0.62);
}

/* the ring colour comes from the token */
@keyframes iu-rail-pulse {
  from {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--iu-accent) 55%, transparent);
  }
  to {
    box-shadow: 0 0 0 6px transparent;
  }
}
@keyframes iu-rail-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
  50% {
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--iu-warning) 40%, transparent);
  }
}

/* line */
.iu-rail__row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.iu-rail__line {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 21px;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--iu-text);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  text-align: left;
}
button.iu-rail__line {
  cursor: pointer;
}
button.iu-rail__line:hover .iu-rail__verb {
  color: var(--iu-text);
}
button.iu-rail__line:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: calc(var(--iu-focus-offset) * -1);
  border-radius: var(--iu-radius-sm);
}

/* tense roll: both tenses are in the DOM; the inactive one is aria-hidden */
.iu-rail__verb {
  display: inline-block;
  flex: none;
  height: 21px;
  line-height: 21px;
  overflow: hidden;
  transition: width var(--iu-dur-roll) var(--iu-ease);
}
.iu-rail__verb > span {
  display: block;
  transition: transform var(--iu-dur-roll) var(--iu-ease);
}
.iu-rail__verb b {
  display: block;
  width: max-content;
  font-weight: var(--iu-font-weight-medium);
  white-space: nowrap;
}
.iu-rail__step[data-live='false'] > .iu-rail__step-in .iu-rail__verb > span {
  transform: translateY(-21px);
}
.iu-rail__step--thinking .iu-rail__verb b {
  font-weight: var(--iu-font-weight-regular);
  font-style: italic;
  color: var(--iu-text-2);
}
.iu-rail__target {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.iu-rail__meta {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  white-space: nowrap;
}
.iu-rail__step[data-status='running'] > .iu-rail__step-in .iu-rail__meta {
  color: var(--iu-accent);
}
.iu-rail__step[data-status='failed'] > .iu-rail__step-in .iu-rail__meta {
  color: var(--iu-danger);
}
.iu-rail__step[data-status='awaiting'] > .iu-rail__step-in .iu-rail__meta {
  color: var(--iu-warning);
}

/* condense and the run body share one fold */
.iu-rail__fold {
  display: grid;
  grid-template-rows: 1fr;
  transition:
    grid-template-rows var(--iu-dur-fold) var(--iu-ease),
    opacity 220ms var(--iu-ease);
}
.iu-rail__fold > * {
  min-height: 0;
  overflow: hidden;
}
.iu-rail__fold[data-shut='true'] {
  grid-template-rows: 0fr;
  opacity: 0;
}

.iu-rail__note {
  padding: 3px 0 2px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12-5);
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.iu-rail__note[data-kind='thinking'] {
  font-style: italic;
}
.iu-rail__body {
  padding: 6px 0 2px;
  min-width: 0;
}

/* nested rail (an agent's own steps) */
.iu-rail__kids {
  position: relative;
  margin-top: 7px;
}
.iu-rail__kids::before {
  content: '';
  position: absolute;
  left: 8.5px;
  top: 8px;
  bottom: 14px;
  width: 1px;
  background: var(--iu-hairline);
}
.iu-rail__kids .iu-rail__step-in {
  padding: 0 0 6px 22px;
}
.iu-rail__kids .iu-rail__node {
  width: 6px;
  height: 6px;
}
.iu-rail__kids .iu-rail__verb b {
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-2);
}

@media (prefers-reduced-motion: reduce) {
  .iu-rail__step,
  .iu-rail__node {
    animation: none !important;
  }
  .iu-rail__verb,
  .iu-rail__verb > span,
  .iu-rail__fold,
  .iu-rail__node {
    transition: none;
  }
}
</style>
