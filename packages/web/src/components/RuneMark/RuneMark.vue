<script setup lang="ts">
// Odin's mark: Ansuz (ᚨ), Odin's rune, cut with angled ends like stone. It takes the colour of the text around it, so
// it stays quiet. Used for the app icon, the favicon and empty states, and nowhere else.
withDefaults(defineProps<{ size?: number }>(), { size: 32 })
</script>

<template>
  <svg
    class="iu-rune-mark"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    aria-hidden="true"
    focusable="false"
  >
    <path
      fill="currentColor"
      d="M10 3 L13.2 4.6 L13.2 29 L10 29 Z M13.2 8 L23.6 13.4 L23.6 17 L13.2 11.8 Z M13.2 15.2 L23.6 20.6 L23.6 24.2 L13.2 19 Z"
    />
  </svg>
</template>

<style>
.iu-rune-mark {
  flex: none;
  display: block;
}
</style>
