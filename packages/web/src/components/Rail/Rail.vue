<script setup lang="ts">
// A run of work on one rail: steps unfurl onto a spine, roll to past tense when they finish, and the run folds to a
// summary line whose dots are the steps. The summary does not exist while the run is live. Nothing here moves focus:
// a fold that would hide the focused step waits until focus leaves the run.
//
// The run's flock: while the run is live and between steps, a working line sits at its tail. When the run ends on
// screen that flock flies up to the summary and comes down in the dots' place (or scatters, leaving a mark, when a
// step failed); once it is down the step dots take over where it rests. A run that was already over when it mounted
// shows the end state with no flight.
import { computed, nextTick, onBeforeUnmount, provide, ref, toRef, useId, watch } from 'vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuFlock from '@/components/Spinner/Flock.vue'
import IuRailStep from './RailStep.vue'
import { RAIL_KEY } from './context'
import { reducedMotion, tokenMs, tokenString } from './motion'
import type { RailStepView } from './types'

defineOptions({ name: 'IuRail' })

// the summary shows this many dots, then +N; the zip only travels for short runs
const MAX_DOTS = 3
const MAX_ZIP = 12
// the flock's own box and where its middle dot sits in it (Spinner/Flock.vue), to line flights up dot on dot
const FLOCK = { w: 34, h: 18, x: 15.5, y: 8.5 }

const props = withDefaults(
  defineProps<{
    steps: RailStepView[]
    /** The summary text, e.g. "Worked for 15s · 1 agent". */
    label: string
    /** The run is the live end of the thread: no summary yet. */
    live: boolean
    /** Directory file paths are shown relative to. */
    root?: string | null
    /** The clock for elapsed time (ms epoch). */
    now?: number
    /** Show the working line at the live end of the run (nothing is streaming and no step says what is happening). */
    working?: boolean
    /** The working line's words. */
    workingLabel?: string
    /** Subagents out: dots that peel off the working flock. */
    agents?: number
    /** How the run ended: its flock lands in the summary or scatters and leaves a mark. Unset = no flock. */
    flock?: 'working' | 'landed' | 'failed' | null
  }>(),
  {
    root: undefined,
    now: undefined,
    working: false,
    workingLabel: 'Working…',
    agents: 0,
    flock: null,
  },
)

// what the host wants; the rail applies it (after the focus guard) and reports the user's own toggles
const folded = defineModel<boolean>('folded', { default: false })
const shut = ref(folded.value)

const initial = new Set<string>()
const collect = (list: RailStepView[]) => {
  for (const s of list) {
    initial.add(s.id)
    collect(s.children ?? [])
  }
}
// eslint-disable-next-line vue/no-setup-props-reactivity-loss -- only what was there at mount
collect(props.steps)
provide(RAIL_KEY, { now: toRef(props, 'now'), root: toRef(props, 'root'), initial })

const bodyId = `${useId()}-run`
const el = ref<HTMLElement>()
const showSummary = computed(() => props.steps.length > 1 && (shut.value || !props.live))
const dots = computed(() => props.steps.slice(0, MAX_DOTS))
const more = computed(() => Math.max(0, props.steps.length - MAX_DOTS))

const focusInside = () => !!el.value && el.value.contains(document.activeElement)
let pending = false

function nodes(): HTMLElement[] {
  return [
    ...(el.value?.querySelectorAll<HTMLElement>(
      ':scope > .iu-rail__fold > div > .iu-rail__inner > .iu-rail__step > .iu-rail__step-in > [data-node]',
    ) ?? []),
  ]
}
const nodeRects = () => nodes().map(n => n.getBoundingClientRect())

function offscreen(): boolean {
  const r = el.value?.getBoundingClientRect()
  return !r || r.bottom < 0 || r.top > window.innerHeight
}

// FLIP: each summary dot starts at its node's position and travels to its slot
async function zip(from: DOMRect[]) {
  await nextTick()
  // while the flock is coming down the dots are not on show: they take over once it has landed
  if (flying.value || reducedMotion() || props.steps.length > MAX_ZIP || !from.length) return
  const target = [...(el.value?.querySelectorAll<HTMLElement>('.iu-rail__dot') ?? [])]
  const duration = tokenMs('--iu-dur-fold', 320)
  const easing = tokenString('--iu-ease', 'cubic-bezier(0.2, 0, 0, 1)')
  target.forEach((dot, i) => {
    const a = from[i]
    if (!a || typeof dot.animate !== 'function') return
    const to = dot.getBoundingClientRect()
    dot.animate(
      [
        { transform: `translate(${a.left - to.left}px, ${a.top - to.top}px)` },
        { transform: 'none' },
      ],
      { duration, delay: i * 25, easing, fill: 'backwards' },
    )
  })
}

function apply(next: boolean) {
  pending = false
  if (next === shut.value) return
  const from = next && !offscreen() ? nodeRects() : []
  shut.value = next
  if (next) void zip(from)
}

watch(folded, next => {
  if (next && focusInside()) {
    pending = true
    return
  }
  apply(next)
})

// ── the flock's flight from the working line to the summary ──
const tailEl = ref<HTMLElement>()
const perchEl = ref<HTMLElement>()
// where the flight is headed, while it lasts; `air` is its first frame, still flying as it was on the working line
const flying = ref<'landed' | 'failed' | null>(null)
const air = ref(false)
let landTimer: ReturnType<typeof setTimeout> | undefined
// a failed run keeps its mark for as long as it is open
const marked = computed(() => props.flock === 'failed' && !props.live)
const perchKind = computed(() => flying.value ?? (marked.value && !shut.value ? 'failed' : null))
const perchState = computed(() => (flying.value && air.value ? 'working' : perchKind.value))

// the flock's middle dot, wherever the box is and however it is scaled
const middle = (r: DOMRect) => ({
  x: r.left + (r.width * FLOCK.x) / FLOCK.w,
  y: r.top + (r.height * FLOCK.y) / FLOCK.h,
})

function endFlight() {
  clearTimeout(landTimer)
  flying.value = null
  air.value = false
}
onBeforeUnmount(() => clearTimeout(landTimer))

watch(
  () => props.live,
  async (live, was) => {
    endFlight()
    const to = props.flock
    if (live || !was || (to !== 'landed' && to !== 'failed')) return
    // a single step has no summary to come down to; reduced motion shows the end state only
    if (props.steps.length < 2 || reducedMotion() || offscreen()) return
    // from the working line, or from the last step when one was still running
    const from = (tailEl.value ?? nodes().at(-1))?.getBoundingClientRect()
    flying.value = to
    air.value = true
    await nextTick()
    const perch = perchEl.value
    if (!perch || flying.value !== to) return endFlight()
    const duration = tokenMs('--iu-dur-land', 600)
    // reading the perch's place also commits the flying frame, so what follows is a transition from it
    const at = perch.getBoundingClientRect()
    if (from && typeof perch.animate === 'function') {
      const a = middle(from)
      const b = middle(at)
      perch.animate(
        [
          {
            translate: `${a.x - b.x}px ${a.y - b.y}px`,
            scale: String(Math.min(1, Math.max(0.4, from.width / FLOCK.w))),
          },
          {},
        ],
        { duration, easing: tokenString('--iu-ease', 'cubic-bezier(0.2, 0, 0, 1)') },
      )
    }
    air.value = false
    // a beat after the dots are down, the step dots take over (or the mark stays)
    landTimer = setTimeout(() => (flying.value = null), duration + 100)
  },
)

function onFocusOut(e: FocusEvent) {
  if (pending && !(e.relatedTarget instanceof Node && el.value?.contains(e.relatedTarget)))
    apply(folded.value)
}

function toggle() {
  const next = !shut.value
  // the user's toggle always applies at once; it is also what the host remembers
  apply(next)
  folded.value = next
}
</script>

<template>
  <div
    ref="el"
    class="iu-rail"
    :class="[
      { 'iu-rail--folded': shut },
      perchKind && `iu-rail--perched iu-rail--perched-${perchKind}`,
    ]"
    :data-folded="shut"
    @focusout="onFocusOut"
  >
    <button
      v-if="showSummary"
      type="button"
      class="iu-rail__sum"
      :aria-expanded="!shut"
      :aria-controls="bodyId"
      @click="toggle"
    >
      <IuIcon name="chevronRight" :size="14" class="iu-rail__chevron" />
      <span class="iu-rail__dots" aria-hidden="true"
        ><Transition name="iu-rail-perch"
          ><span
            v-if="perchKind && perchState"
            ref="perchEl"
            class="iu-rail__perch"
            :class="`iu-rail__perch--${perchKind}`"
            ><IuFlock :state="perchState" /></span></Transition
        ><span
          v-for="s in dots"
          :key="s.id"
          class="iu-rail__dot"
          :class="`iu-rail__dot--${s.kind}`"
        /><span v-if="more" class="iu-rail__more">+{{ more }}</span></span
      >
      <span>{{ label }}</span>
    </button>

    <div :id="bodyId" class="iu-rail__fold" :data-shut="shut">
      <div :inert="shut || undefined">
        <div class="iu-rail__inner">
          <IuRailStep v-for="s in steps" :key="s.id" :step="s">
            <template #actions="a"><slot name="actions" v-bind="a" /></template>
            <template #body="b"><slot name="body" v-bind="b" /></template>
            <template #after="a"><slot name="after" v-bind="a" /></template>
          </IuRailStep>
        </div>
        <div v-if="live && working" class="iu-rail__tail" role="status">
          <span ref="tailEl" class="iu-rail__tail-flock" aria-hidden="true"
            ><IuFlock :agents="agents"
          /></span>
          <span>{{ workingLabel }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.iu-rail {
  min-width: 0;
}
.iu-rail__sum {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  margin: 0 0 2px -6px;
  padding: 0 10px 0 6px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text-2);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12-5);
  text-align: left;
  cursor: pointer;
}
.iu-rail__sum:hover {
  background: var(--iu-surface);
  color: var(--iu-text);
}
.iu-rail__sum:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.iu-rail__chevron {
  flex: none;
  transform: rotate(90deg);
  transition: transform var(--iu-dur-fold) var(--iu-ease);
}
.iu-rail--folded .iu-rail__chevron {
  transform: none;
}
.iu-rail__dots {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  transition:
    max-width var(--iu-dur-fold) var(--iu-ease),
    min-width var(--iu-dur) var(--iu-ease),
    opacity var(--iu-dur) var(--iu-ease);
}
.iu-rail--folded .iu-rail__dots {
  max-width: 200px;
  opacity: 1;
  overflow: visible;
}
.iu-rail__dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--iu-border-strong);
}
.iu-rail__dot,
.iu-rail__more {
  transition: opacity var(--iu-dur) var(--iu-ease);
}

/* the perch: where the run's flock comes down, over the dots' own places. The flock rests three dots 8px apart and
   the summary's dots are 13px apart (7px + 6px gap), so the landing flock is drawn 13/8 up and its middle dot sits
   on the middle dot's place: when it is down, each resting dot is on a step dot, which then takes over. */
.iu-rail--perched .iu-rail__dots {
  max-width: 200px;
  opacity: 1;
  overflow: visible;
}
.iu-rail--perched-landed .iu-rail__dots {
  min-width: 33px;
}
.iu-rail--perched-failed .iu-rail__dots {
  min-width: 7px;
  min-height: 7px;
}
.iu-rail--perched .iu-rail__dot,
.iu-rail--perched .iu-rail__more {
  opacity: 0;
}
.iu-rail--perched-failed .iu-rail__dot,
.iu-rail--perched-failed .iu-rail__more {
  display: none;
}
.iu-rail__perch {
  position: absolute;
  left: 1px;
  top: calc(50% - 8.5px);
  display: inline-flex;
  transform-origin: 15.5px 8.5px;
  pointer-events: none;
}
.iu-rail__perch--landed {
  scale: 1.625;
}
/* the mark a failure leaves sits where the first dot would */
.iu-rail__perch--failed {
  left: -12px;
}
.iu-rail-perch-leave-active {
  transition: opacity var(--iu-dur) var(--iu-ease);
}
.iu-rail-perch-leave-to {
  opacity: 0;
}

/* the working line at the live end of the run: its flock sits on the spine, where the next step will be */
.iu-rail__tail {
  position: relative;
  display: flex;
  align-items: center;
  min-height: 21px;
  padding: 0 0 9px 32px;
  color: var(--iu-text-muted);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
}
.iu-rail__tail-flock {
  position: absolute;
  left: -6px;
  top: 2px;
  display: inline-flex;
}
.iu-rail__dot--thinking {
  border-radius: var(--iu-radius-xs);
  rotate: 45deg;
  scale: 0.85;
}
.iu-rail__dot--agent {
  border-radius: 2px;
}
.iu-rail__more {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.iu-rail__inner {
  position: relative;
}
.iu-rail__inner::before {
  content: '';
  position: absolute;
  left: 9px;
  top: 10px;
  bottom: 18px;
  width: 1px;
  background: var(--iu-border);
}

@media (prefers-reduced-motion: reduce) {
  .iu-rail__chevron,
  .iu-rail__dots,
  .iu-rail__dot,
  .iu-rail__more,
  .iu-rail-perch-leave-active {
    transition: none;
  }
}
</style>
