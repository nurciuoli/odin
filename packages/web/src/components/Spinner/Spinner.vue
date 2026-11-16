<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: number
    tone?: 'accent' | 'current'
    // with a label the spinner is a status region; without one it is decorative
    label?: string
  }>(),
  { size: 12, tone: 'accent' },
)
</script>

<template>
  <span
    class="iu-spinner"
    :class="`iu-spinner--${tone}`"
    :style="{
      '--iu-spinner-size': `${size}px`,
      '--iu-spinner-bw': `${Math.max(1.5, size / 8)}px`,
    }"
    :role="label ? 'status' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  />
</template>

<style>
.iu-spinner {
  display: inline-block;
  flex: none;
  vertical-align: middle;
  box-sizing: border-box;
  width: var(--iu-spinner-size);
  height: var(--iu-spinner-size);
  border-radius: 50%;
  border-style: solid;
  border-width: var(--iu-spinner-bw);
  border-color: var(--iu-border);
  border-top-color: var(--iu-accent);
  animation: iu-spinner-rotate 0.7s linear infinite;
}

/* inherits the surrounding ink: track is a quiet tint of it, head is the full colour */
.iu-spinner--current {
  border-color: color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
}

/* slow rather than stop: a frozen spinner reads as broken */
@media (prefers-reduced-motion: reduce) {
  .iu-spinner {
    animation-duration: 2s;
  }
}

@keyframes iu-spinner-rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>
