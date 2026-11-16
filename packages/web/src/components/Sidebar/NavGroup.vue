<script setup lang="ts">
// IuNavGroup.vue — a mono uppercase, collapsible section label. Never a
// clickable destination itself. When the rail is collapsed the group's own
// header disappears and its children flatten to the rail's top level, each
// falling back to IuNavItem's own icon + tooltip presentation.
//
// Uncontrolled by default (`defaultOpen` seeds internal state). Pass `open`
// (or `v-model:open`) to control it from outside — e.g. to persist which
// groups are collapsed, or to force groups open while a filter is active.
//
// The optional `actions` slot puts small controls (e.g. an icon-only ghost
// IuButton) at the right end of the header row. They sit beside the toggle,
// never inside it, so clicking one doesn't fold the group; they hide with the
// header when the rail is collapsed.
import { computed, ref, inject, type Ref } from 'vue'
import { IuIcon } from '@/components/Icon'

const props = withDefaults(
  defineProps<{
    label: string
    defaultOpen?: boolean
    /** controlled open state; leave undefined to let the group manage itself */
    open?: boolean
  }>(),
  { defaultOpen: true, open: undefined },
)

const emit = defineEmits<{ 'update:open': [open: boolean] }>()

const collapsed = inject<Ref<boolean>>('iu-sidebar-collapsed', { value: false } as Ref<boolean>)
// defaultOpen is an initial value by definition (uncontrolled mode)
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const internalOpen = ref(props.defaultOpen)
const open = computed(() => props.open ?? internalOpen.value)

function toggle() {
  if (collapsed.value) return
  const next = !open.value
  internalOpen.value = next
  emit('update:open', next)
}
</script>

<template>
  <div class="iu-nav-group" :class="{ 'is-open': open }">
    <div v-if="!collapsed" class="iu-nav-group__row">
      <button type="button" class="iu-nav-group__header" :aria-expanded="open" @click="toggle">
        <IuIcon name="chevronDown" :size="14" class="iu-nav-group__chevron" />
        <span class="iu-nav-group__label">{{ label }}</span>
      </button>
      <div v-if="$slots.actions" class="iu-nav-group__actions">
        <slot name="actions" />
      </div>
    </div>
    <div v-show="collapsed || open" class="iu-nav-group__body">
      <slot />
    </div>
  </div>
</template>

<style>
.iu-nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.iu-nav-group__row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.iu-nav-group__header {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 8px 10px 5px;
  border: none;
  background: transparent;
  cursor: pointer;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-disabled);
  text-align: left;
}
.iu-nav-group__header:hover {
  color: var(--iu-text-2);
}
.iu-nav-group__header:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}

/* header actions (size="sm" ghost icon buttons fit the row height) */
.iu-nav-group__actions {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 6px;
}

/* IuIcon only ships 14/16/20/24 sizes; scaled down to sit closer to the
   mockup's 11px glyph next to the 10.5px group label */
.iu-nav-group__chevron {
  flex: none;
  transform: scale(0.8);
  transition: transform 120ms ease;
}
.iu-nav-group:not(.is-open) .iu-nav-group__chevron {
  transform: scale(0.8) rotate(-90deg);
}

.iu-nav-group__body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* nested rows indent under the group header; the rail is the one place an
   unlabelled icon is allowed, so collapsed items don't get that indent —
   they flatten to the same alignment as top-level rows */
.iu-nav-group__body .iu-nav-item {
  padding-left: 26px;
}
.iu-sidebar.is-collapsed .iu-nav-group__body .iu-nav-item {
  padding-left: 0;
}

@media (prefers-reduced-motion: reduce) {
  .iu-nav-group__chevron {
    transition: none;
  }
}
</style>
