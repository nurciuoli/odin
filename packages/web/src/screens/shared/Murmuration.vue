<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { createFlock, type FlockInput } from './murmuration'

// The home flock: two loose parties of ravens. While the sky above Home is stormy the flock settles lower and tighter;
// the canvas itself stays clear of any tint (the clouds and lightning are StormSky's).
const props = withDefaults(
  defineProps<{
    /** the sky is stormy: a session is running, waiting for you or unread */
    stormy?: boolean
  }>(),
  { stormy: false },
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
  let gather = 0
  const css = getComputedStyle(el)
  const text = css.getPropertyValue('--iu-text-2').trim()
  const accent = css.getPropertyValue('--iu-accent').trim()
  const idle: FlockInput = { pointer: null, gather: 0 }
  function paint() {
    ctx!.setTransform(scale, 0, 0, scale, 0, 0)
    ctx!.clearRect(0, 0, width, height)
    flock.draw(ctx!, text, accent, time, motion.matches)
  }
  function tick(now: number) {
    frame = 0
    const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 1 / 60
    previous = now
    time += dt
    gather += ((props.stormy ? 1 : 0) - gather) * (1 - Math.exp(-dt / (props.stormy ? 7 : 10)))
    input.gather = gather
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
      // No motion: the flock sits where it would settle
      flock = createFlock(width, height)
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
    // a flock that mounts mid-run starts under the clouds rather than watching them arrive
    gather = props.stormy ? 1 : 0
    input.gather = gather
    sync()
  }
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
