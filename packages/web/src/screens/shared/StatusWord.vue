<script setup lang="ts">
// The state's word, set the same on every surface: mono caps in the body ink colour, with an optional lowercase
// duration after it ("NEEDS YOU 2m"). Colour never goes on this text; the flock, a wash or a rail carry it.
defineProps<{ word: string; since?: string }>()
</script>

<template>
  <span class="status-word"
    >{{ word }}<span v-if="since" class="status-word__since">{{ since }}</span></span
  >
</template>

<style>
.status-word {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-semibold);
  letter-spacing: var(--iu-tracking-caps-tight);
  text-transform: uppercase;
  color: var(--iu-text);
  white-space: nowrap;
}
.status-word__since {
  margin-inline-start: 0.6em;
  font-weight: var(--iu-font-weight-regular);
  letter-spacing: 0;
  text-transform: none;
  color: var(--iu-text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
