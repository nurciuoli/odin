<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createFlock, type FlockInput } from './murmuration'
import { createStorm, type FlashKind } from './storm'

// The home flock. While sessions run, storm clouds crawl in from both sides above it; a finished session or one that
// needs you lights the clouds with a faint flash, like lightning far off.
const props = withDefaults(
  defineProps<{
    /** sessions running right now: clouds are in while this is above zero */
    running?: number
    /** each new `id` is one flash */
    signal?: { id: number; kind: FlashKind } | null
  }>(),
  { running: 0, signal: null },
)
const canvas = ref<HTMLCanvasElement | null>(null)
const input: FlockInput = { pointer: null, gather: 0 }
let time = 0
let dispose = () => {}

function point(event: PointerEvent) {
  const rect = canvas.value?.getBoundingClientRect()
  if (rect) input.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top }
}

onMounted(() => {
  const el = canvas.value
  const ctx = el?.getContext('2d')
  if (!el || !ctx) return
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  let visible = true
  let frame = 0
  let previous = 0
  let width = 0,
    height = 0,
    scale = 1
  let flock = createFlock(1, 1)
  let storm = createStorm(1, 1)
  const css = getComputedStyle(el)
  const text = css.getPropertyValue('--iu-text-2').trim()
  const accent = css.getPropertyValue('--iu-accent').trim()
  const colors = {
    cloud: css.getPropertyValue('--iu-text-muted').trim(),
    glow: css.getPropertyValue('--iu-info').trim(),
    lit: css.getPropertyValue('--iu-text').trim(),
  }
  const idle: FlockInput = { pointer: null, gather: 0 }
  function paint() {
    ctx!.setTransform(scale, 0, 0, scale, 0, 0)
    ctx!.clearRect(0, 0, width, height)
    storm.draw(ctx!, time, colors, { drift: !motion.matches, calm: motion.matches })
    flock.draw(ctx!, text, accent)
  }
  function tick(now: number) {
    frame = 0
    const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 1 / 60
    previous = now
    time += dt
    storm.step(time, dt, props.running)
    input.gather = storm.gather
    flock.step(time, dt, input)
    paint()
    frame = requestAnimationFrame(tick)
  }
  function sync() {
    cancelAnimationFrame(frame)
    frame = 0
    previous = 0
    if (width < 2 || height < 2) return
    if (motion.matches) {
      // No crawl and no flicker: clouds sit where they would settle, and a flash is one slow, dim swell.
      flock = createFlock(width, height)
      storm.settle(props.running)
      for (let t = 0; t < 7.6; t += 1 / 30) flock.step(t, 1 / 30, idle)
      paint()
    } else if (visible && !document.hidden) frame = requestAnimationFrame(tick)
  }
  function size() {
    const rect = el!.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (width === rect.width && height === rect.height && scale === dpr) return
    width = rect.width
    height = rect.height
    scale = dpr
    el!.width = Math.round(width * scale)
    el!.height = Math.round(height * scale)
    flock = createFlock(width, height)
    storm = createStorm(width, height)
    // a flock that mounts mid-run starts under the clouds rather than watching them arrive
    storm.settle(props.running)
    sync()
  }
  const stopRunning = watch(
    () => props.running,
    () => {
      if (motion.matches) {
        storm.settle(props.running)
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
        storm.step(time, dt, props.running)
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
  intersection.observe(el)
  motion.addEventListener('change', sync)
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('resize', size)
  size()
  dispose = () => {
    cancelAnimationFrame(frame)
    stopRunning()
    stopSignal()
    resize.disconnect()
    intersection.disconnect()
    motion.removeEventListener('change', sync)
    document.removeEventListener('visibilitychange', sync)
    window.removeEventListener('resize', size)
  }
})
onBeforeUnmount(() => dispose())
</script>

<template>
  <canvas
    ref="canvas"
    class="murmuration"
    aria-hidden="true"
    @pointermove="point"
    @pointerleave="input.pointer = null"
    @pointercancel="input.pointer = null"
  />
</template>

<style>
.murmuration {
  display: block;
  width: 100%;
  height: 280px;
}
@media (max-width: 540px) {
  .murmuration {
    height: 220px;
  }
}
</style>
