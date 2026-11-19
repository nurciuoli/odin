<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createStorm, type FlashKind } from './storm'

// The sky across the top of Home, the full width of the main pane (behind the sidebar): an endless stream of clouds while there is weather,
// a flash of light when a session finishes or needs you. Clouds are painted below the app bar. The canvas sits behind
// the page and never takes the pointer.
const props = withDefaults(
  defineProps<{
    /** there is weather: clouds drift in from both sides while true and drift away once it ends */
    active?: boolean
    /** each new `id` is one flash */
    signal?: { id: number; kind: FlashKind } | null
  }>(),
  { active: false, signal: null },
)
const canvas = ref<HTMLCanvasElement | null>(null)
let dispose = () => {}

onMounted(() => {
  const el = canvas.value
  const ctx = el?.getContext('2d')
  if (!el || !ctx) return
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let visible = true
  let frame = 0
  let previous = 0
  let time = 0
  let width = 0,
    height = 0,
    scale = 1
  let storm = createStorm(1, 1)
  const css = getComputedStyle(el)
  const colors = {
    cloud: css.getPropertyValue('--iu-text-muted').trim(),
    ground: css.getPropertyValue('--iu-ground').trim(),
    glow: css.getPropertyValue('--iu-info').trim(),
    lit: css.getPropertyValue('--iu-text').trim(),
  }
  const pane = el.closest('.iu-shell__main')
  const header = pane?.querySelector<HTMLElement>(':scope > .iu-shell__header')
  function barHeight() {
    const h = header?.getBoundingClientRect().height ?? 0
    return h > 0 ? h : 48
  }
  function paint() {
    ctx!.setTransform(scale, 0, 0, scale, 0, 0)
    ctx!.clearRect(0, 0, width, height)
    storm.draw(ctx!, time, colors, {
      drift: !motion.matches,
      calm: motion.matches,
      bar: barHeight(),
    })
  }
  function tick(now: number) {
    frame = 0
    const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 1 / 60
    previous = now
    time += dt
    storm.step(time, dt, props.active)
    paint()
    frame = requestAnimationFrame(tick)
  }
  function sync() {
    cancelAnimationFrame(frame)
    frame = 0
    previous = 0
    if (width < 2 || height < 2) return
    if (motion.matches) {
      // No drift and no flicker: the clouds sit where the stream would be, and a flash is one slow, dim swell.
      storm.settle(props.active)
      paint()
    } else if (visible && !document.hidden) frame = requestAnimationFrame(tick)
  }
  // the sky fills the main pane, edge to edge, and stays behind the sidebar: follow the pane's left edge and width
  function fit() {
    const box = pane?.getBoundingClientRect()
    el!.style.left = box ? `${box.left}px` : '0'
    el!.style.width = box ? `${box.width}px` : '100vw'
  }
  function size() {
    fit()
    const rect = el!.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (width === rect.width && height === rect.height && scale === dpr) {
      if (motion.matches) paint()
      return
    }
    width = rect.width
    height = rect.height
    scale = dpr
    el!.width = Math.round(width * scale)
    el!.height = Math.round(height * scale)
    storm = createStorm(width, height, scale)
    // a sky that mounts mid-weather is already full of cloud rather than watching it arrive
    storm.settle(props.active)
    sync()
  }
  const stopActive = watch(
    () => props.active,
    () => {
      if (motion.matches) {
        storm.settle(props.active)
        paint()
      }
    },
  )
  const stopSignal = watch(
    () => props.signal?.id,
    () => {
      if (!props.signal) return
      if (!motion.matches) return storm.flash(time, props.signal.kind)
      // reduced motion: a single dim, slow swell on a short loop instead of a flicker
      storm.flash(time, 'done')
      const start = performance.now()
      let last = 0
      const swell = (now: number) => {
        const dt = last ? (now - last) / 1000 : 1 / 60
        last = now
        time += dt
        storm.step(time, dt, props.active)
        paint()
        if (now - start < 2400) frame = requestAnimationFrame(swell)
      }
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(swell)
    },
  )
  const resize = new ResizeObserver(size)
  const intersection = new IntersectionObserver(entries => {
    visible = entries[0]?.isIntersecting ?? false
    sync()
  })
  resize.observe(el)
  if (pane) resize.observe(pane)
  if (header) resize.observe(header)
  intersection.observe(el)
  motion.addEventListener('change', sync)
  document.addEventListener('visibilitychange', sync)
  size()
  dispose = () => {
    cancelAnimationFrame(frame)
    stopActive()
    stopSignal()
    resize.disconnect()
    intersection.disconnect()
    motion.removeEventListener('change', sync)
    document.removeEventListener('visibilitychange', sync)
  }
})
onBeforeUnmount(() => dispose())
</script>

<template>
  <canvas ref="canvas" class="storm-sky" aria-hidden="true" />
</template>

<style>
.storm-sky {
  position: fixed;
  top: 0;
  left: 0;
  z-index: -1;
  width: 100vw; /* narrowed to the main pane once mounted */
  height: min(100vh, 460px);
  pointer-events: none;
}
</style>
