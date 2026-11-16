<script setup lang="ts">
// IuSidebar.vue — shell only; items come in through slots
import { provide } from 'vue'

const collapsed = defineModel<boolean>('collapsed', { default: false })
withDefaults(defineProps<{ width?: number; id?: string }>(), { width: 240 })

// children read this to decide label vs tooltip
provide('iu-sidebar-collapsed', collapsed)
</script>

<template>
  <nav
    :id="id"
    class="iu-sidebar"
    :class="{ 'is-collapsed': collapsed }"
    :style="{ '--w': (collapsed ? 52 : width) + 'px' }"
    aria-label="Primary"
  >
    <div class="iu-sidebar__head"><slot name="workspace" /></div>
    <div class="iu-sidebar__body"><slot /></div>
    <div class="iu-sidebar__foot"><slot name="footer" /></div>
  </nav>
</template>

<style>
.iu-sidebar {
  width: var(--w);
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 100dvh;
  background: var(--iu-well);
  border-right: 1px solid var(--iu-border-quiet);
  transition: width 140ms ease;
}
.iu-sidebar__body {
  flex: 1;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--iu-border-strong) transparent;
  padding: 10px 8px;
}
.iu-sidebar__foot {
  flex: none;
  margin-top: auto;
  border-top: 1px solid var(--iu-border-quiet);
  padding: 8px;
}

/* selection = raised row + 2px ember marker, never the accent fill */
.iu-nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 9px;
  height: 32px;
  padding: 0 10px;
  border-radius: var(--iu-radius-md);
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-13-5);
}
.iu-nav-item:hover {
  background: var(--iu-hover);
  color: var(--iu-text);
}
.iu-nav-item.is-active {
  background: var(--iu-raised);
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
}
.iu-nav-item.is-active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--iu-accent);
}
.iu-sidebar.is-collapsed .iu-nav-item__label {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .iu-sidebar {
    transition: none;
  }
}
@media (max-width: 860px) {
  .iu-sidebar:not(.is-collapsed) {
    position: fixed;
    z-index: 20;
    inset-block: 0;
    inset-inline-start: 0;
    max-height: 100dvh;
    box-shadow: var(--iu-shadow-raised);
  }
}
</style>
