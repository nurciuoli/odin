<script setup lang="ts">
// IuNavItem.vue — 32px row · 16px icon · 9px gap · 13.5px label. Renders as
// a router-link when `to` is given, otherwise a plain button. Presentation
// (rest/hover/active/marker) is owned by IuSidebar's shared .iu-nav-item
// rules; this file only adds what's specific to a single row: the icon,
// the label-vs-tooltip swap when the rail is collapsed, the trailing count
// chip / attention dot, the leading status dot, and the disabled state.
import { inject, type Ref } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { IuIcon, type IconName } from '@/components/Icon'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import type { Status } from '@/styles/status'

const props = withDefaults(
  defineProps<{
    label: string
    /** Optional second line for session activity. */
    description?: string
    to?: RouteLocationRaw
    icon?: IconName
    /** leading status dot in the icon's place, e.g. a project's health; announced with the label */
    status?: Status
    count?: number
    /** bare "needs attention" dot — used when there's nothing to count */
    attention?: boolean
    active?: boolean
    disabled?: boolean
  }>(),
  { attention: false, active: false, disabled: false },
)

// set by the nearest IuSidebar; falls back to "expanded" outside one
const collapsed = inject<Ref<boolean>>('iu-sidebar-collapsed', { value: false } as Ref<boolean>)

function onClick(e: MouseEvent) {
  if (props.disabled) {
    e.preventDefault()
    e.stopPropagation()
  }
}
</script>

<template>
  <component
    :is="to ? 'router-link' : 'button'"
    class="iu-nav-item"
    :class="{ 'is-active': active, 'is-disabled': disabled, 'has-description': description }"
    :to="to"
    :type="to ? undefined : 'button'"
    :disabled="!to ? disabled : undefined"
    :aria-disabled="to && disabled ? 'true' : undefined"
    :aria-current="active ? 'page' : undefined"
    :title="collapsed ? label : undefined"
    @click="onClick"
  >
    <span v-if="$slots.leading" class="iu-nav-item__leading"><slot name="leading" /></span>
    <IuIcon v-else-if="icon" :name="icon" :size="16" class="iu-nav-item__icon" />
    <span v-else-if="status" class="iu-nav-item__icon iu-nav-item__status"
      ><IuStatusDot :status="status"
    /></span>
    <span class="iu-nav-item__label">
      <slot name="content">
        <span class="iu-nav-item__title">{{ label }}</span>
        <span v-if="description" class="iu-nav-item__description">{{ description }}</span>
      </slot>
    </span>
    <span v-if="count !== undefined" class="iu-nav-item__count">{{ count }}</span>
    <span v-else-if="attention" class="iu-nav-item__dot" aria-hidden="true" />
  </component>
</template>

<style>
/* button reset — router-link is already a bare <a> */
button.iu-nav-item {
  width: 100%;
  border: none;
  background: none;
  text-align: left;
  text-decoration: none;
  font: inherit;
  cursor: pointer;
}

.iu-nav-item:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: calc(var(--iu-focus-offset) * -1);
}

.iu-nav-item.is-disabled {
  color: var(--iu-text-disabled);
  cursor: not-allowed;
  pointer-events: none;
}

.iu-nav-item__status {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
}

.iu-nav-item__icon {
  flex: none;
  color: inherit;
}

.iu-nav-item__label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iu-nav-item.has-description {
  height: auto;
  min-height: 52px;
  padding-block: 8px;
}
.iu-nav-item__leading {
  flex: none;
  width: 28px;
  display: grid;
  place-items: center;
}
.iu-nav-item__title,
.iu-nav-item__description {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iu-nav-item__description {
  margin-top: 3px;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-regular);
}

.iu-nav-item__count {
  flex: none;
  margin-left: auto;
  padding: 1px 6px;
  border-radius: 9px;
  background: var(--iu-accent-wash);
  border: 1px solid var(--iu-accent-border);
  color: var(--iu-accent);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
}

.iu-nav-item__dot {
  flex: none;
  margin-left: auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--iu-warning);
}

/* collapsed rail: every row becomes a centered 34px icon button, label and
   trailing indicators disappear, the tooltip (native :title) is what's left */
.iu-sidebar.is-collapsed .iu-nav-item {
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  margin: 0 auto;
}
.iu-sidebar.is-collapsed .iu-nav-item__count,
.iu-sidebar.is-collapsed .iu-nav-item__dot {
  display: none;
}
</style>
