<script setup lang="ts">
// IuShell.vue — the only element allowed to own 100dvh
//
// The header band renders only when the `header` slot is given: a page that draws its own column headers (a
// three-column workspace) leaves it out. `flush` drops the content padding for pages that lay out edge-to-edge
// columns and scroll inside them.
withDefaults(defineProps<{ flush?: boolean }>(), { flush: false })
</script>

<template>
  <div class="iu-shell">
    <slot name="rail" />
    <div class="iu-shell__main">
      <header v-if="$slots.header" class="iu-shell__header"><slot name="header" /></header>
      <main class="iu-shell__content" :class="{ 'iu-shell__content--flush': flush }" tabindex="-1">
        <slot />
      </main>
    </div>
  </div>
</template>

<style>
.iu-shell {
  display: flex;
  height: 100dvh;
  overflow: hidden;
  background: var(--iu-ground);
}
.iu-shell__main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.iu-shell__header {
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
/* the header does not float, so it gets no shadow — only a hairline */
/* an IuHeader dropped into the header slot already sits inside this band —
   let it fill the band instead of drawing a second padding + hairline */
.iu-shell__header > .iu-header {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border-bottom: none;
  background: transparent;
}
.iu-shell__content {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 20px;
}
.iu-shell__content--flush {
  padding: 0;
  overflow: hidden;
}
.iu-shell__content:focus-visible {
  outline: none;
}
</style>
