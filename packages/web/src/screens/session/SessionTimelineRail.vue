<script setup lang="ts">
// The timeline's resting state: a thin strip down the thread's left gutter, one segment per user message, sized by
// how long the step ran. It starts short and grows a little with every message, then thins once it fills the gutter.
// The step on screen is lit. Pointing at a segment (or focusing it) previews that step in plain text beside it; a
// click scrolls the thread there and leaves a "Back to step N" below the strip. ⌥T still opens the full timeline.
import { computed, ref } from 'vue'
import { IuIcon } from '@/components/Icon'
import { stepClock, stepWeights, type TimelineStep } from './timeline'

const props = defineProps<{
  steps: TimelineStep[]
  /** Index of the step on screen. */
  current: number
  /** Step number to return to after a jump, or null when the reader hasn't jumped. */
  back: number | null
}>()
const emit = defineEmits<{ jump: [index: number]; back: [] }>()

const shown = ref<number | null>(null)
const peekTop = ref(0)
const strip = ref<HTMLElement | null>(null)

function peek(i: number, e: Event) {
  const li = (e.currentTarget as HTMLElement).parentElement
  if (!li) return
  shown.value = i
  peekTop.value = li.offsetTop + li.offsetHeight / 2
}

function onKeydown(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
  if (!d) return
  const buttons = [...(strip.value?.querySelectorAll<HTMLButtonElement>('.rail__seg') ?? [])]
  const at = buttons.findIndex(b => b === document.activeElement)
  const next = buttons[Math.min(buttons.length - 1, Math.max(0, at + d))]
  if (!next) return
  e.preventDefault()
  next.focus({ preventScroll: true })
}

const label = (s: TimelineStep) => {
  const when = stepClock(s.at)
  return `Step ${s.n}${when ? `, ${when}` : ''}: ${s.prompt.slice(0, 80)}`
}
const weights = computed(() => stepWeights(props.steps))
</script>

<template>
  <nav
    class="rail"
    aria-label="Session steps"
    :style="{ '--rail-n': steps.length }"
    @keydown="onKeydown"
    @mouseleave="shown = null"
  >
    <div class="rail__strip-wrap">
      <ol ref="strip" class="rail__strip">
        <li
          v-for="(s, i) in steps"
          :key="s.id"
          class="rail__item"
          :style="{ flex: `${weights[i]} 1 0` }"
        >
          <button
            type="button"
            class="rail__seg"
            :class="{ 'is-current': i === current, 'is-peeked': i === shown }"
            :aria-label="label(s)"
            :aria-current="i === current ? 'step' : undefined"
            :tabindex="i === current ? 0 : -1"
            @mouseenter="peek(i, $event)"
            @focus="peek(i, $event)"
            @blur="shown = null"
            @click="emit('jump', i)"
          ></button>
        </li>
      </ol>
      <div
        v-if="shown !== null && steps[shown]"
        class="rail__peek"
        :style="{ top: `${peekTop}px` }"
        aria-hidden="true"
      >
        <p class="rail__peek-prompt">
          <span class="rail__peek-at">{{ stepClock(steps[shown]!.at) || steps[shown]!.n }}</span
          >{{ steps[shown]!.prompt }}
        </p>
        <p v-if="steps[shown]!.reply" class="rail__peek-reply">{{ steps[shown]!.reply }}</p>
        <p class="rail__peek-meta">
          <span v-if="!steps[shown]!.tools">no tool calls</span>
          <span v-if="steps[shown]!.files"
            >{{ steps[shown]!.files }} file{{ steps[shown]!.files === 1 ? '' : 's' }}</span
          >
          <span v-if="steps[shown]!.failed" class="rail__flag--failed"
            >{{ steps[shown]!.failed }} failed</span
          >
          <span v-if="steps[shown]!.agents">agent</span>
        </p>
      </div>
    </div>
    <button v-if="back !== null" type="button" class="rail__back" @click="emit('back')">
      <IuIcon name="chevronLeft" :size="14" />Back to step {{ back }}
    </button>
  </nav>
</template>

<style>
.rail {
  position: absolute;
  z-index: 4;
  left: 16px;
  top: 28px;
  bottom: 150px;
  width: 22px;
  display: none;
  flex-direction: column;
  gap: 10px;
}
/* only where the thread leaves a gutter wide enough for the strip; its preview is plain text in the gutter when there
   is room for it and a small card over the thread when there isn't */
@container session-main (min-width: 880px) {
  .rail {
    display: flex;
  }
}
.rail__strip-wrap {
  position: relative;
  flex: 0 1 calc(var(--rail-n) * 38px);
  min-height: 0;
}
.rail__strip {
  list-style: none;
  margin: 0;
  padding: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 3px;
  position: relative;
}
.rail__item {
  min-height: 3px;
  position: relative;
}
.rail__seg {
  position: absolute;
  inset: 0 auto 0 0;
  width: 22px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}
.rail__seg::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  border-radius: var(--iu-radius-xs);
  background: var(--iu-border-strong);
  opacity: 0.55;
  transition:
    width var(--iu-dur-fast) var(--iu-ease),
    opacity var(--iu-dur-fast) var(--iu-ease);
}
.rail__seg.is-current::before {
  background: var(--iu-text);
  opacity: 1;
}
.rail__seg.is-peeked::before,
.rail__seg:hover::before {
  width: 4px;
  opacity: 1;
  background: var(--iu-text-2);
}
.rail__seg.is-current.is-peeked::before {
  background: var(--iu-text);
}
.rail__seg:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: 0;
  border-radius: var(--iu-radius-xs);
}
.rail__peek {
  position: absolute;
  left: 30px;
  width: clamp(150px, calc(50cqw - 440px), 292px);
  transform: translateY(-50%);
  pointer-events: none;
  background: radial-gradient(ellipse at 40% 50%, var(--iu-ground) 55%, transparent 100%);
  padding: 6px 10px 6px 0;
}
.rail__peek p {
  margin: 0;
}
.rail__peek-prompt {
  color: var(--iu-text);
  font-size: var(--iu-font-size-12-5);
  line-height: var(--iu-leading-snug);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.rail__peek-at {
  margin-right: 8px;
  color: var(--iu-text-disabled);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
}
.rail__peek-reply {
  margin-top: 3px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11-5);
  line-height: var(--iu-leading-snug);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.rail__peek-meta {
  margin-top: 4px;
  display: flex;
  gap: 8px;
  color: var(--iu-text-muted);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
}
.rail__peek-meta:empty {
  display: none;
}
.rail__flag--failed {
  color: var(--iu-danger);
}
.rail__back {
  flex: none;
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--iu-text-muted);
  font: inherit;
  font-size: var(--iu-font-size-11-5);
  white-space: nowrap;
  cursor: pointer;
}
.rail__back:hover {
  color: var(--iu-text);
}
.rail__back:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: 2px;
}
@container session-main (max-width: 1160px) {
  .rail__peek {
    width: 280px;
    padding: 10px 12px;
    background: var(--iu-surface);
    border: 1px solid var(--iu-border);
    border-radius: var(--iu-radius-lg);
    box-shadow: var(--iu-shadow-popover);
  }
}
@media (prefers-reduced-motion: reduce) {
  .rail__seg::before {
    transition: none;
  }
}
</style>
