<script lang="ts">
// Shared by every card (a plain script block: bindings in <script setup> are per instance). At most one is open,
// and for a short "warm" window after one closes the next opens instantly.
let current: { close: () => void } | null = null
let lastClosedAt = 0
const WARM_MS = 500
</script>

<script setup lang="ts">
// HoverCard.vue — a read-only overview that opens beside a trigger on hover or keyboard focus, without a click.
//
// The trigger is the default slot's one element; its own click, link and menu behaviour is untouched. The card is
// a description of it (aria-describedby while open), not a dialog: focus never moves into it, and it holds nothing
// you must reach with the keyboard, so anything actionable stays on the trigger.
//
// Timing: opens after `openDelay` of steady hover so sweeping the mouse across a list stays quiet; closes after
// `closeDelay` so the pointer can cross the gap onto the card (to select text or scroll). Once any card is open,
// or one closed under 500 ms ago, the next opens instantly, so moving down a list reads as one continuous peek.
// Keyboard: focus that matches :focus-visible opens it after the same delay; Esc closes it and keeps it shut until
// the trigger is left; blur closes at once. Touch never opens it. Clicking the trigger closes it.
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    placement?: 'right-start' | 'bottom-start'
    openDelay?: number
    closeDelay?: number
    disabled?: boolean
    width?: number
    /** Accessible name for the card. */
    label?: string
  }>(),
  { placement: 'right-start', openDelay: 450, closeDelay: 200, disabled: false, width: 320 },
)

const GAP = 8
const EDGE = 8

const root = ref<HTMLElement | null>(null)
const card = ref<HTMLElement | null>(null)
const open = ref(false)
const style = ref<Record<string, string>>({})
const id = useId()
let timer: ReturnType<typeof setTimeout> | undefined
let dismissed = false
const self = { close: () => hide() }

const anchor = () => (root.value?.firstElementChild as HTMLElement | null) ?? null
const clear = () => {
  clearTimeout(timer)
  timer = undefined
}

function show() {
  if (props.disabled || dismissed || open.value) return
  current?.close()
  current = self
  open.value = true
}
function hide() {
  clear()
  if (!open.value) return
  open.value = false
  lastClosedAt = Date.now()
  if (current === self) current = null
}
function schedule(kind: 'open' | 'close', delay: number) {
  clear()
  if (kind === 'open' && (current || Date.now() - lastClosedAt < WARM_MS)) delay = 0
  if (delay === 0) {
    if (kind === 'open') show()
    else hide()
  } else timer = setTimeout(kind === 'open' ? show : hide, delay)
}

const onEnter = (e: PointerEvent) => {
  if (e.pointerType !== 'mouse') return
  schedule('open', props.openDelay)
}
const onLeave = (e: PointerEvent) => {
  if (e.pointerType !== 'mouse') return
  dismissed = false
  clear()
  if (open.value) schedule('close', props.closeDelay)
}
const onFocusIn = (e: FocusEvent) => {
  const target = e.target as HTMLElement
  if (!target.matches?.(':focus-visible')) return
  schedule('open', props.openDelay)
}
const onFocusOut = (e: FocusEvent) => {
  if (root.value?.contains(e.relatedTarget as Node | null)) return
  dismissed = false
  hide()
}
const onKey = (e: KeyboardEvent) => {
  if (e.key !== 'Escape' || !open.value) return
  e.stopPropagation()
  dismissed = true
  hide()
}
const onPress = () => {
  dismissed = true
  hide()
}

function place() {
  const a = anchor()?.getBoundingClientRect()
  const c = card.value
  if (!a || !c) return
  const w = c.offsetWidth
  const h = c.offsetHeight
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (props.placement === 'right-start') {
    const fitsRight = a.right + GAP + w + EDGE <= vw
    const left = fitsRight ? a.right + GAP : Math.max(EDGE, a.left - GAP - w)
    // Line the card's top edge up with the row, then slide it up if it would run off the bottom.
    const top = Math.max(EDGE, Math.min(a.top - 6, vh - h - EDGE))
    style.value = { left: `${left}px`, top: `${top}px` }
  } else {
    const below = a.bottom + GAP + h + EDGE <= vh
    const top = below ? a.bottom + GAP : Math.max(EDGE, a.top - GAP - h)
    const left = Math.max(EDGE, Math.min(a.left, vw - w - EDGE))
    style.value = { left: `${left}px`, top: `${top}px` }
  }
}
const dismiss = () => hide()
watch(open, async value => {
  const a = anchor()
  if (value) {
    a?.setAttribute('aria-describedby', id)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    await nextTick()
    place()
  } else {
    a?.removeAttribute('aria-describedby')
    window.removeEventListener('scroll', dismiss, true)
    window.removeEventListener('resize', dismiss)
  }
})
// Content may load asynchronously and change the card's height; keep it inside the viewport.
let observer: ResizeObserver | null = null
watch(card, el => {
  observer?.disconnect()
  if (el && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(place)
    observer.observe(el)
  }
})
onBeforeUnmount(() => {
  hide()
  observer?.disconnect()
  window.removeEventListener('scroll', dismiss, true)
  window.removeEventListener('resize', dismiss)
})
const cardStyle = computed(() => ({ ...style.value, width: `${props.width}px` }))
</script>

<template>
  <span
    ref="root"
    class="iu-hovercard-root"
    @pointerenter="onEnter"
    @pointerleave="onLeave"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
    @keydown="onKey"
    @pointerdown="onPress"
  >
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="open"
      :id="id"
      ref="card"
      class="iu-hovercard"
      role="tooltip"
      :aria-label="label"
      :style="cardStyle"
      @pointerenter="clear"
      @pointerleave="onLeave"
    >
      <slot name="card" />
    </div>
  </Teleport>
</template>

<style>
/* No box of its own: the trigger keeps its place in whatever layout it sits in. */
.iu-hovercard-root {
  display: contents;
}
.iu-hovercard {
  position: fixed;
  z-index: 60;
  box-sizing: border-box;
  max-width: calc(100vw - 16px);
  padding: 12px 14px;
  background: var(--iu-surface-raised);
  color: var(--iu-text);
  border: 1px solid var(--iu-border-strong);
  border-radius: var(--iu-radius-lg);
  box-shadow: var(--iu-shadow-popover);
  font-size: var(--iu-font-size-13);
  animation: iu-hovercard-in 120ms ease-out;
}
@keyframes iu-hovercard-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .iu-hovercard {
    animation: none;
  }
}
</style>
