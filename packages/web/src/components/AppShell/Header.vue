<script setup lang="ts">
// IuHeader.vue — the 48px header band: location on the left, actions on the
// right, nothing hardcoded in the middle. Content comes in entirely through
// slots so the same band works for a search box, a breadcrumb, a primary
// action button, an avatar — whatever the page needs — without this
// component knowing about any of them.
</script>

<template>
  <div class="iu-header">
    <div class="iu-header__start"><slot name="breadcrumb" /></div>
    <div class="iu-header__end"><slot name="actions" /></div>
  </div>
</template>

<style>
.iu-header {
  height: 48px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 14px;
  background: var(--iu-ground);
  border-bottom: 1px solid var(--iu-border-quiet);
  /* the header does not float, so it gets no shadow — only a hairline */
}
.iu-header__start {
  display: flex;
  align-items: center;
  min-width: 0;
  flex: 1;
}
.iu-header__end {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
  flex: none;
}
</style>
