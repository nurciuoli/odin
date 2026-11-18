<script setup lang="ts">
import { computed, nextTick, reactive, ref, useId, useTemplateRef, watchEffect } from 'vue'
import type { PermissionPromptQuestion } from './types'
import IuButton from '@/components/Button/Button.vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuRadio from '@/components/Fields/Radio.vue'
import IuCheckbox from '@/components/Fields/Checkbox.vue'
import IuTextarea from '@/components/Fields/Textarea.vue'

// One question at a time, with a step indicator, Prev/Next and a review step before submitting. Owns the answers;
// the parent reads them through `update:answers` and the final `submit`.
const props = withDefaults(
  defineProps<{ questions: PermissionPromptQuestion[]; busy?: boolean }>(),
  { busy: false },
)
const emit = defineEmits<{
  'update:answers': [answers: Record<string, string>]
  /** The keyboard tips for the current step, shown by the card in its header. */
  hint: [hint: string]
  submit: []
}>()

// TEMP (design exploration): ?qv=centered|split|stacked|chips|inline
const variant =
  (typeof location !== 'undefined' && new URLSearchParams(location.search).get('qv')) || 'centered'
const uid = useId()
const root = useTemplateRef<HTMLElement>('root')

const keyOf = (q: PermissionPromptQuestion) => q.id ?? q.question
const picked = reactive<Record<string, string>>({})
const checked = reactive<Record<string, string[]>>({})
const written = reactive<Record<string, string>>({})

const answerOf = (q: PermissionPromptQuestion) => {
  const key = keyOf(q)
  return (
    written[key]?.trim() || (q.multiSelect ? (checked[key] ?? []).join(', ') : (picked[key] ?? ''))
  )
}
const answers = computed<Record<string, string>>(() => {
  const out: Record<string, string> = {}
  for (const q of props.questions) {
    const v = answerOf(q)
    if (v) out[keyOf(q)] = v
  }
  return out
})
watchEffect(() => emit('update:answers', answers.value))
const complete = computed(() => props.questions.every(q => answers.value[keyOf(q)] !== undefined))

// steps 0..n-1 are the questions; step n is the review (only when there is more than one question)
const count = computed(() => props.questions.length)
const hasReview = computed(() => count.value > 1)
const lastStep = computed(() => (hasReview.value ? count.value : count.value - 1))
const step = ref(0)
const onReview = computed(() => hasReview.value && step.value === count.value)
const question = computed(() => props.questions[step.value])

const hint = computed(() =>
  onReview.value
    ? '← → move · Enter submits'
    : variant === 'chips'
      ? '1–9 choose · Enter confirms'
      : '← → move · 1–9 choose · Enter confirms',
)
watchEffect(() => emit('hint', hint.value))

async function go(to: number, focusSlide = false) {
  step.value = Math.min(Math.max(to, 0), lastStep.value)
  if (focusSlide) {
    // keyboard navigation only: focus follows the person's own action, never content arriving by itself
    await nextTick()
    root.value?.querySelector<HTMLElement>('.iu-question-carousel__slide')?.focus()
  }
}

function toggle(key: string, label: string, on: boolean) {
  const cur = checked[key] ?? []
  checked[key] = on ? [...cur.filter(l => l !== label), label] : cur.filter(l => l !== label)
}
function pick(q: PermissionPromptQuestion, index: number) {
  const o = q.options[index]
  if (!o || props.busy) return
  const key = keyOf(q)
  if (q.multiSelect) toggle(key, o.label, !(checked[key] ?? []).includes(o.label))
  else picked[key] = o.label
}

const isFinal = computed(() =>
  count.value === 0 ? true : hasReview.value ? onReview.value : step.value === count.value - 1,
)
function advance(focusSlide = false) {
  if (props.busy) return
  if (isFinal.value) {
    if (complete.value) emit('submit')
  } else void go(step.value + 1, focusSlide)
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.altKey) return
  const target = e.target as HTMLElement
  const inText =
    target.tagName === 'TEXTAREA' ||
    (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'text')
  const onButton = target.tagName === 'BUTTON'
  const mod = e.ctrlKey || e.metaKey
  if (mod && e.key === 'Enter') {
    // confirm from anywhere, including the free-text box
    e.preventDefault()
    e.stopPropagation()
    if (question.value && !answerOf(question.value)) return
    advance(true)
    return
  }
  if (mod || inText) return
  if (e.key === 'ArrowRight') {
    e.preventDefault()
    void go(step.value + 1, true)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    void go(step.value - 1, true)
  } else if (/^[1-9]$/.test(e.key) && question.value && !onReview.value) {
    e.preventDefault()
    pick(question.value, Number(e.key) - 1)
  } else if (e.key === 'Enter' && !onButton) {
    e.preventDefault()
    if (onReview.value || (question.value && answerOf(question.value))) advance(true)
  }
}

const stepLabel = (i: number) => {
  const q = props.questions[i]!
  return `Question ${i + 1}: ${q.header || q.question}${answers.value[keyOf(q)] !== undefined ? ', answered' : ', not answered'}`
}
</script>

<template>
  <div
    ref="root"
    class="iu-question-carousel"
    role="group"
    aria-roledescription="carousel"
    aria-label="Questions from the agent"
    @keydown="onKeydown"
  >
    <div
      :key="step"
      class="iu-question-carousel__slide"
      tabindex="-1"
      role="group"
      aria-roledescription="slide"
      :aria-label="onReview ? 'Review answers' : `Question ${step + 1} of ${count}`"
    >
      <template v-if="onReview">
        <p class="iu-question-carousel__prompt">Review your answers</p>
        <ul class="iu-question-carousel__review">
          <li v-for="(q, i) in questions" :key="keyOf(q)">
            <div class="iu-question-carousel__review-q">
              <span v-if="q.header" class="iu-question-carousel__qhead">{{ q.header }}</span>
              {{ q.question }}
            </div>
            <div class="iu-question-carousel__review-a">
              <span v-if="answers[keyOf(q)] !== undefined">{{ answers[keyOf(q)] }}</span>
              <span v-else class="iu-question-carousel__missing">Not answered yet</span>
              <IuButton variant="ghost" size="sm" :disabled="busy" @click="go(i)">
                {{ answers[keyOf(q)] !== undefined ? 'Edit' : 'Answer' }}
              </IuButton>
            </div>
          </li>
        </ul>
      </template>

      <fieldset v-else-if="question" class="iu-question-carousel__q">
        <legend class="iu-question-carousel__legend">
          <span v-if="question.header" class="iu-question-carousel__qhead">{{
            question.header
          }}</span>
          <span class="iu-question-carousel__prompt">{{ question.question }}</span>
        </legend>
        <p v-if="question.multiSelect" class="iu-question-carousel__hint">Choose any that apply.</p>
        <div v-for="(o, oi) in question.options" :key="o.label" class="iu-question-carousel__opt">
          <kbd v-if="oi < 9" class="iu-question-carousel__key" aria-hidden="true">{{ oi + 1 }}</kbd>
          <div class="iu-question-carousel__optbody">
            <IuCheckbox
              v-if="question.multiSelect"
              :label="o.label"
              :model-value="(checked[keyOf(question)] ?? []).includes(o.label)"
              :disabled="busy"
              @update:model-value="toggle(keyOf(question), o.label, $event)"
            />
            <IuRadio
              v-else
              v-model="picked[keyOf(question)]"
              :name="`${uid}-${keyOf(question)}`"
              :value="o.label"
              :label="o.label"
              :disabled="busy"
            />
            <span v-if="o.description" class="iu-question-carousel__optdesc">{{
              o.description
            }}</span>
          </div>
        </div>
        <IuTextarea
          v-model="written[keyOf(question)]"
          :label="
            question.options.length ? 'Other answer (overrides selected choices)' : 'Your answer'
          "
          :disabled="busy"
          :rows="2"
        />
      </fieldset>
    </div>

    <div class="iu-question-carousel__bar" :class="`is-${variant}`">
      <div v-if="hasReview" class="iu-question-carousel__steps">
        <span class="iu-question-carousel__count" aria-live="polite">{{
          onReview ? 'Review' : `${step + 1} of ${count}`
        }}</span>
        <ol class="iu-question-carousel__dots">
          <li v-for="(q, i) in questions" :key="keyOf(q)">
            <button
              type="button"
              class="iu-question-carousel__dot"
              :class="{
                'is-current': step === i,
                'is-answered': answers[keyOf(q)] !== undefined,
              }"
              :aria-label="stepLabel(i)"
              :aria-current="step === i ? 'step' : undefined"
              :disabled="busy"
              @click="go(i)"
            >
              <IuIcon
                v-if="answers[keyOf(q)] !== undefined && step !== i"
                name="check"
                :size="14"
              />
            </button>
          </li>
          <li>
            <button
              type="button"
              class="iu-question-carousel__dot iu-question-carousel__dot--review"
              :class="{ 'is-current': onReview }"
              aria-label="Review and submit"
              :aria-current="onReview ? 'step' : undefined"
              :disabled="busy"
              @click="go(count)"
            >
              ✓
            </button>
          </li>
        </ol>
      </div>

      <div class="iu-question-carousel__nav" :class="`is-${variant}`">
        <IuButton
          v-if="hasReview"
          :variant="variant === 'centered' ? 'secondary' : 'ghost'"
          size="sm"
          class="iu-question-carousel__back"
          :disabled="busy || step === 0"
          @click="go(step - 1)"
        >
          <template #icon><IuIcon name="chevronLeft" :size="14" /></template>
          Back
          <template v-if="variant === 'chips'" #trailing><kbd class="iu-btn__kbd">←</kbd></template>
        </IuButton>
        <IuButton
          v-if="isFinal"
          variant="primary"
          size="sm"
          class="iu-permission-prompt__allow iu-question-carousel__next"
          :disabled="busy || !complete"
          @click="advance()"
        >
          Submit answers
        </IuButton>
        <IuButton
          v-else
          variant="primary"
          size="sm"
          class="iu-question-carousel__next"
          :disabled="busy"
          @click="advance()"
        >
          {{ step === count - 1 ? 'Review answers' : 'Next' }}
          <template #trailing>
            <kbd v-if="variant === 'chips'" class="iu-btn__kbd">→</kbd>
            <IuIcon v-else name="chevronRight" :size="14" />
          </template>
        </IuButton>
      </div>
    </div>
  </div>
</template>

<style>
.iu-question-carousel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.iu-question-carousel__steps {
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 6px;
}
.iu-question-carousel__count {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.iu-question-carousel__dots {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.iu-question-carousel__dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: var(--iu-font-size-10-5);
  line-height: var(--iu-leading-none);
  color: var(--iu-text-muted);
  background: transparent;
  border: 1px solid var(--iu-border);
  border-radius: 50%;
  cursor: pointer;
}
.iu-question-carousel__dot.is-answered {
  color: var(--iu-text);
  border-color: var(--iu-info);
}
.iu-question-carousel__dot.is-current {
  background: var(--iu-info);
  border-color: var(--iu-info);
  color: var(--iu-bg);
}
.iu-question-carousel__dot:disabled {
  cursor: default;
  opacity: 0.6;
}
.iu-question-carousel__dot:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.iu-question-carousel__slide {
  min-width: 0;
  animation: iu-question-in 0.16s ease-out;
}
.iu-question-carousel__slide:focus-visible {
  /* only ever focused by the arrow/Enter keys, to keep them working: a ring around the whole slide is noise */
  outline: none;
}
@keyframes iu-question-in {
  from {
    opacity: 0;
    transform: translateX(8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .iu-question-carousel__slide {
    animation: none;
  }
}
.iu-question-carousel__q {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: none;
}
.iu-question-carousel__legend {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  margin-bottom: 2px;
}
.iu-question-carousel__qhead {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.iu-question-carousel__prompt {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.iu-question-carousel__hint {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.iu-question-carousel__opt {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.iu-question-carousel__key {
  flex: none;
  box-sizing: border-box;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 500 var(--iu-font-size-11) / 1 var(--iu-font-mono);
  color: var(--iu-text-muted);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
}
.iu-question-carousel__optbody {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.iu-question-carousel__optdesc {
  padding-left: 26px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.iu-question-carousel__review {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.iu-question-carousel__review > li {
  padding-bottom: 8px;
  border-bottom: 1px solid var(--iu-border);
}
.iu-question-carousel__review-q {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.iu-question-carousel__review-a {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
  overflow-wrap: anywhere;
}
.iu-question-carousel__missing {
  color: var(--iu-text-muted);
  font-style: italic;
}
.iu-question-carousel__nav {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
/* design exploration variants */
.iu-question-carousel__bar {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.iu-question-carousel__bar.is-inline {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 8px 10px;
}
.iu-question-carousel__bar.is-inline .iu-question-carousel__nav {
  display: contents;
}
.iu-question-carousel__bar.is-inline .iu-question-carousel__back {
  grid-row: 1;
  grid-column: 1;
  justify-self: start;
}
.iu-question-carousel__bar.is-inline .iu-question-carousel__steps {
  grid-row: 1;
  grid-column: 2;
}
.iu-question-carousel__bar.is-inline .iu-question-carousel__next {
  grid-row: 1;
  grid-column: 3;
  justify-self: end;
}
.iu-question-carousel__nav.is-split {
  flex-wrap: nowrap;
  justify-content: space-between;
}
.iu-question-carousel__nav.is-stacked .iu-question-carousel__next {
  order: -1;
  flex: 1 1 100%;
  justify-content: center;
}
.iu-question-carousel__nav.is-stacked {
  justify-content: flex-start;
}
</style>
