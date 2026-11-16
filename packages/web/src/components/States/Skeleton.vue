<script setup lang="ts">
// IuSkeleton.vue — embedded source is complete, used verbatim.
withDefaults(
  defineProps<{
    shape?: 'text' | 'row' | 'table' | 'card'
    rows?: number
  }>(),
  { shape: 'text', rows: 3 },
)
</script>

<template>
  <div class="iu-skel" :class="`iu-skel--${shape}`" role="status" aria-busy="true">
    <span class="sr-only">Loading…</span>
    <div
      v-for="n in rows"
      :key="n"
      class="iu-skel__row"
      :class="{ 'is-live': n === 1 }"
      :style="{ opacity: 1 - (n - 1) * 0.28 }"
    />
  </div>
</template>

<style>
.iu-skel {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
/* only the first row shimmers — a full grid of motion reads as broken */
.iu-skel__row {
  height: 9px;
  border-radius: 3px;
  background: var(--iu-raised);
}
.iu-skel__row.is-live {
  background: linear-gradient(
    90deg,
    var(--iu-raised) 0%,
    var(--iu-hover) 40%,
    var(--iu-raised) 80%
  );
  background-size: 280px 100%;
  animation: iu-shimmer 1.4s linear infinite;
}
@keyframes iu-shimmer {
  from {
    background-position: -280px 0;
  }
  to {
    background-position: 280px 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .iu-skel__row.is-live {
    animation: none;
    background: var(--iu-hover);
  }
}
</style>
