<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import type { ApprovalRequest, ApprovalState } from '@/components/Chat/types'
import type { Status } from '@/styles/status'
import IuButton from '@/components/Button/Button.vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuEyebrow from '@/components/Eyebrow/Eyebrow.vue'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import IuCodeBlock from '@/components/CodeBlock/CodeBlock.vue'
import IuDiff from '@/components/CodeBlock/Diff.vue'

const props = withDefaults(
  defineProps<{
    request: ApprovalRequest
    shortcuts?: boolean
    autofocus?: boolean
  }>(),
  {
    shortcuts: true,
    autofocus: false,
  },
)

const emit = defineEmits<{
  approve: []
  deny: []
  always: []
}>()

// read once: the hint glyph has to match the modifier onKeydown checks
const platform =
  typeof navigator === 'undefined'
    ? ''
    : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ?? navigator.platform)
const isMac = /Mac|iPhone|iPad/i.test(platform)
const approveHint = isMac ? '⌘↵' : 'Ctrl↵'

const pending = computed(() => props.request.state === 'pending')
const high = computed(() => props.request.risk === 'high')

const inputText = computed<string | undefined>(() => {
  const v = props.request.input
  if (v === undefined) return undefined
  return typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v))
})
const hasDetails = computed(
  () => (props.request.diff?.length ?? 0) > 0 || inputText.value !== undefined,
)

// high-risk opens its details: the reviewer should see what changes before deciding.
// Re-evaluated per request, so a reused card doesn't keep the previous one's state.
const detailsOpen = ref(false)
watch(
  () => props.request.id,
  () => {
    detailsOpen.value = high.value
  },
  { immediate: true },
)
const detailsId = `${useId()}-details`

const RESOLVED: Record<Exclude<ApprovalState, 'pending'>, { label: string; status: Status }> = {
  approved: { label: 'Approved', status: 'ok' },
  always: { label: 'Always allowed', status: 'ok' },
  denied: { label: 'Denied', status: 'failed' },
}
const resolved = computed(() =>
  props.request.state === 'pending' ? null : RESOLVED[props.request.state],
)

const resolvedTime = computed(() => {
  const at = props.request.resolvedAt
  if (!at) return ''
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
})

const card = ref<HTMLElement | null>(null)

// shortcuts only fire while focus is inside the card, never globally
function onKeydown(e: KeyboardEvent) {
  if (!props.shortcuts || e.isComposing) return
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
    e.preventDefault()
    emit('approve')
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    emit('deny')
  }
}

function focusApproveIn(root: ParentNode) {
  root.querySelector<HTMLButtonElement>('.iu-approval__approve')?.focus()
}

onMounted(() => {
  if (props.autofocus && pending.value && card.value) focusApproveIn(card.value)
})

// the card is removed and re-inserted on reset, so focus on enter, not only on mount
const reduceMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

function durationOf(el: Element) {
  return parseFloat(getComputedStyle(el).getPropertyValue('--iu-dur')) || 160
}

// WAAPI rather than CSS classes: the collapse needs measured px heights, and the
// easing is hard-coded because WAAPI cannot read var(--iu-ease)
const EASE = 'cubic-bezier(.2, 0, 0, 1)'
const COLLAPSED_HEIGHT = 28

// if the decision was made from inside the card (keyboard or click), focus
// follows it to the resolved line instead of falling back to <body>
let hadFocus = false

function onEnter(el: Element, done: () => void) {
  if (el.classList.contains('iu-approval') && props.autofocus) focusApproveIn(el)
  if (el.classList.contains('iu-approval-line') && hadFocus)
    (el as HTMLElement).focus({ preventScroll: true })
  hadFocus = false
  if (reduceMotion()) return done()
  el.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: durationOf(el),
    easing: EASE,
  }).onfinish = () => done()
}

// the card shrinks to the resolved line's 28px, so the line swaps in with no jump
function onLeave(el: Element, done: () => void) {
  const node = el as HTMLElement
  // only when the decision came from the keyboard — after a mouse click a ring on the line is noise
  hadFocus = !!node.querySelector(':focus-visible')
  if (reduceMotion()) return done()
  const from = node.getBoundingClientRect().height
  node.style.overflow = 'hidden'
  node.animate(
    [
      { height: `${from}px`, opacity: 1 },
      { height: `${COLLAPSED_HEIGHT}px`, opacity: 0 },
    ],
    { duration: durationOf(el), easing: EASE },
  ).onfinish = () => done()
}
</script>

<template>
  <div class="iu-approval-root">
    <Transition mode="out-in" :css="false" @enter="onEnter" @leave="onLeave">
      <div
        v-if="pending"
        key="pending"
        ref="card"
        class="iu-approval"
        :class="{ 'is-high': high }"
        role="group"
        :aria-label="`Approval needed: ${request.summary}`"
        @keydown="onKeydown"
      >
        <div class="iu-approval__top">
          <IuStatusDot status="awaiting" :size="7" decorative />
          <IuEyebrow>Approval needed</IuEyebrow>
          <span v-if="high" class="iu-approval__risk">▲ High risk</span>
        </div>

        <div class="iu-approval__summary">{{ request.summary }}</div>

        <div class="iu-approval__tool">
          <span class="iu-approval__name">{{ request.tool }}</span>
          <span v-if="request.target" class="iu-approval__target">{{ request.target }}</span>
        </div>

        <div v-if="hasDetails" class="iu-approval__details">
          <IuButton
            variant="ghost"
            size="sm"
            class="iu-approval__toggle"
            :aria-expanded="detailsOpen"
            :aria-controls="detailsId"
            @click="detailsOpen = !detailsOpen"
          >
            <template #icon>
              <IuIcon :name="detailsOpen ? 'chevronDown' : 'chevronRight'" :size="14" />
            </template>
            {{ detailsOpen ? 'Hide details' : 'Show details' }}
          </IuButton>

          <div v-show="detailsOpen" :id="detailsId" class="iu-approval__body">
            <IuDiff
              v-if="request.diff?.length"
              :hunks="request.diff"
              :copyable="false"
              max-height="220px"
            />
            <IuCodeBlock
              v-if="inputText !== undefined"
              :code="inputText"
              language="input"
              max-height="220px"
            />
          </div>
        </div>

        <div class="iu-approval__actions">
          <IuButton
            variant="primary"
            size="sm"
            class="iu-approval__approve"
            @click="emit('approve')"
          >
            Approve
            <template #trailing>
              <kbd v-if="shortcuts" class="iu-btn__kbd">{{ approveHint }}</kbd>
            </template>
          </IuButton>
          <IuButton variant="secondary" size="sm" class="iu-approval__deny" @click="emit('deny')">
            Deny
            <template #trailing>
              <kbd v-if="shortcuts" class="iu-btn__kbd">Esc</kbd>
            </template>
          </IuButton>
          <IuButton variant="ghost" size="sm" class="iu-approval__always" @click="emit('always')">
            Always allow {{ request.tool }}
          </IuButton>
        </div>
      </div>

      <div
        v-else-if="resolved"
        key="resolved"
        class="iu-approval-line"
        :data-state="request.state"
        tabindex="-1"
      >
        <IuStatusDot :status="resolved.status" :size="7" decorative />
        <span class="iu-approval-line__text">{{ resolved.label }}</span>
        <span class="iu-approval-line__sep" aria-hidden="true">·</span>
        <span class="iu-approval-line__tool">{{ request.tool }}</span>
        <span v-if="request.resolvedBy" class="iu-approval-line__by"
          >by {{ request.resolvedBy }}</span
        >
        <time v-if="resolvedTime" class="iu-approval-line__time" :datetime="request.resolvedAt">{{
          resolvedTime
        }}</time>
      </div>
    </Transition>

    <span class="iu-approval__sr" role="status">{{ resolved?.label ?? '' }}</span>
  </div>
</template>

<style>
.iu-approval-root {
  position: relative;
  min-width: 0;
}

/* pending card: the one loud thing in the thread until someone decides */
.iu-approval {
  container-type: inline-size;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--iu-surface);
  border: 1px solid var(--iu-info-border);
  border-left: 3px solid var(--iu-info);
  border-radius: var(--iu-radius-lg);
}

.iu-approval.is-high {
  border-color: var(--iu-warning-border);
  border-left-color: var(--iu-warning);
}

.iu-approval__top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.iu-approval__risk {
  margin-left: auto;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  line-height: var(--iu-leading-snug);
  white-space: nowrap;
  color: var(--iu-warning);
}

.iu-approval__summary {
  font-size: var(--iu-font-size-13-5);
  font-weight: var(--iu-font-weight-medium);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text);
  overflow-wrap: anywhere;
}

.iu-approval__tool {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 8px;
  min-width: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-normal);
}

/* identifiers never break mid-word: on narrow cards the target drops to its
   own line, and only then does either side ellipsize */
.iu-approval__name {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--iu-text-2);
}
.iu-approval__target {
  flex: 1 1 120px;
}

.iu-approval__target {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--iu-text-muted);
}

.iu-approval__details {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.iu-approval__toggle {
  margin-left: -7px;
}

.iu-approval__body {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.iu-approval__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* "Always" sits at the right on wide cards, and drops to the left when the row wraps */
.iu-approval__always {
  margin-left: auto;
}

@container (max-width: 400px) {
  .iu-approval__always {
    margin-left: 0;
  }
}

/* resolved: one quiet 28px line, no card chrome */
.iu-approval-line:focus {
  outline: none;
}
.iu-approval-line:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
  border-radius: var(--iu-radius-sm);
}
.iu-approval-line {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  min-width: 0;
  font-size: var(--iu-font-size-12-5);
  line-height: var(--iu-leading-none);
  white-space: nowrap;
  color: var(--iu-text-2);
}

.iu-approval-line__sep {
  flex: none;
  color: var(--iu-text-muted);
}

.iu-approval-line__tool {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}

.iu-approval-line__by {
  flex: none;
  color: var(--iu-text-muted);
}

.iu-approval-line__time {
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}

.iu-approval__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
