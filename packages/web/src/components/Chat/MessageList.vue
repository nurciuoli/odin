<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import IuButton from '@/components/Button/Button.vue'
import IuIcon from '@/components/Icon/Icon.vue'

// Scroll model: the list is "stuck" while the reader sits within stickThreshold of
// the bottom. Stuck + content grows -> follow instantly (smooth fights a token stream).
// Unstuck -> never move the reader; offer a pill instead.
const props = withDefaults(
  defineProps<{
    ariaLabel?: string
    maxWidth?: string
    stickThreshold?: number
    newCount?: number
    // the default slot can't be inspected for emptiness reliably (comments, whitespace),
    // so the parent says so and the `empty` slot renders in its place
    empty?: boolean
  }>(),
  {
    ariaLabel: 'Conversation',
    maxWidth: '760px',
    stickThreshold: 64,
    empty: false,
  },
)

const scroller = ref<HTMLElement | null>(null)
const column = ref<HTMLElement | null>(null)

const atBottom = ref(true)
const isAtBottom = computed(() => atBottom.value)
const showPill = computed(() => !atBottom.value)

function distanceFromBottom(el: HTMLElement): number {
  return el.scrollHeight - el.scrollTop - el.clientHeight
}
function nearBottom(el: HTMLElement): boolean {
  return distanceFromBottom(el) <= props.stickThreshold
}

// Set on wheel-up, upward touch drags and navigation keys. It is a short-lived
// "the reader is moving" signal, so a no-op wheel at the bottom cannot wedge follow mode.
let upIntent = false
let upTimer: number | undefined
function markUpIntent() {
  upIntent = true
  window.clearTimeout(upTimer)
  upTimer = window.setTimeout(() => {
    upIntent = false
  }, 400)
}
function onWheel(e: WheelEvent) {
  if (e.deltaY < 0) markUpIntent()
}
let touchY = 0
function onTouchStart(e: TouchEvent) {
  touchY = e.touches[0]?.clientY ?? 0
}
function onTouchMove(e: TouchEvent) {
  const y = e.touches[0]?.clientY ?? touchY
  // finger moving down means content moving up, i.e. the reader scrolling up
  if (y > touchY) markUpIntent()
  touchY = y
}
const UP_KEYS = ['ArrowUp', 'PageUp', 'Home']
function onKeydown(e: KeyboardEvent) {
  if (UP_KEYS.includes(e.key)) markUpIntent()
}

function onScroll() {
  const el = scroller.value
  if (el) atBottom.value = nearBottom(el)
}

function scrollToBottom(smooth = false) {
  const el = scroller.value
  if (!el) return
  upIntent = false
  // a smooth glide keeps atBottom false until it lands, so the follow observer stays out of its way
  if (!smooth) atBottom.value = true
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

function jumpToLatest() {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  scrollToBottom(!reduced)
}

// Fires for new messages and for streaming growth of the last one. It reads atBottom,
// which only scroll events and this observer write, so it still holds the pre-change state.
let ro: ResizeObserver | undefined
onMounted(() => {
  scrollToBottom()
  ro = new ResizeObserver(() => {
    const el = scroller.value
    if (!el) return
    if (atBottom.value && !upIntent) {
      el.scrollTop = el.scrollHeight
    } else {
      atBottom.value = nearBottom(el)
    }
  })
  if (scroller.value) ro.observe(scroller.value)
  if (column.value) ro.observe(column.value)
})

onBeforeUnmount(() => {
  ro?.disconnect()
  window.clearTimeout(upTimer)
})

defineExpose({ scrollToBottom, isAtBottom })
</script>

<template>
  <div class="iu-msglist">
    <div
      ref="scroller"
      class="iu-msglist__scroller"
      role="log"
      :aria-label="ariaLabel"
      tabindex="0"
      @scroll="onScroll"
      @wheel.passive="onWheel"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
      @keydown="onKeydown"
    >
      <div ref="column" class="iu-msglist__column" :style="{ maxWidth }">
        <div v-if="$slots.before" class="iu-msglist__before"><slot name="before" /></div>
        <slot />
        <div v-if="empty" class="iu-msglist__empty"><slot name="empty" /></div>
      </div>
    </div>

    <Transition name="iu-msglist-pill">
      <div v-if="showPill" class="iu-msglist__pill">
        <IuButton class="iu-msglist__jump" variant="secondary" size="sm" @click="jumpToLatest">
          <template #icon><IuIcon name="arrowDown" :size="14" /></template>
          {{ newCount ? `${newCount} new` : 'Jump to latest' }}
        </IuButton>
      </div>
    </Transition>
  </div>
</template>

<style>
.iu-msglist {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.iu-msglist__scroller {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  scroll-behavior: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--iu-border) transparent;
}
.iu-msglist__scroller:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: 1px;
}

.iu-msglist__column {
  width: 100%;
  box-sizing: border-box;
  margin: 0 auto;
  padding: 24px 20px 32px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.iu-msglist__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
  text-align: center;
}

.iu-msglist__pill {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 14px;
  display: flex;
  justify-content: center;
  pointer-events: none;
  transition:
    opacity var(--iu-dur) ease,
    transform var(--iu-dur) ease;
}
.iu-msglist__pill > * {
  pointer-events: auto;
}
.iu-msglist__pill .iu-msglist__jump {
  background: var(--iu-surface-raised);
  box-shadow: 0 6px 16px color-mix(in srgb, var(--iu-well) 70%, transparent);
}

.iu-msglist-pill-enter-from,
.iu-msglist-pill-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
@media (prefers-reduced-motion: reduce) {
  .iu-msglist__pill {
    transition: opacity var(--iu-dur) ease;
  }
  .iu-msglist-pill-enter-from,
  .iu-msglist-pill-leave-to {
    transform: none;
  }
}
</style>
