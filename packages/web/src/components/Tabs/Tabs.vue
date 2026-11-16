<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'

export interface Tab {
  id: string
  label: string
  badge?: string | number
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    tabs: Tab[]
    variant?: 'underline' | 'segmented' | 'vertical'
    lazy?: boolean
    overflow?: 'menu' | 'wrap'
    /**
     * false: render only the tab list. The consumer draws the panel itself (elsewhere in its layout) and gives it
     * `id="<idBase>-panel-<tab id>"`, `role="tabpanel"` and `aria-labelledby="<idBase>-tab-<tab id>"`.
     */
    panels?: boolean
    /** Prefix of the tab and panel ids. Generated when not given; pass one when `panels` is false. */
    idBase?: string
  }>(),
  { variant: 'underline', lazy: true, overflow: 'menu', panels: true, idBase: undefined },
)

const active = defineModel<string>({ required: true })
const generated = useId()
const base = computed(() => props.idBase ?? generated)
const seen = ref(new Set([active.value]))
const enabled = () => props.tabs.filter(t => !t.disabled)

function onKeydown(e: KeyboardEvent) {
  const list = enabled()
  const i = list.findIndex(t => t.id === active.value)
  const next = {
    ArrowRight: i + 1,
    ArrowDown: i + 1,
    ArrowLeft: i - 1,
    ArrowUp: i - 1,
    Home: 0,
    End: list.length - 1,
  }[e.key]
  if (next === undefined) return
  e.preventDefault()
  const id = list[(next + list.length) % list.length].id
  select(id)
  // roving tabindex: the key moved the selection, so focus follows it
  void nextTick(() => document.getElementById(`${base.value}-tab-${id}`)?.focus())
}

function select(id: string) {
  active.value = id
  seen.value.add(id)
}
</script>

<template>
  <div class="iu-tabs" :class="`iu-tabs--${variant}`">
    <div class="iu-tabs__list" role="tablist" @keydown="onKeydown">
      <button
        v-for="t in tabs"
        :key="t.id"
        :id="`${base}-tab-${t.id}`"
        class="iu-tabs__tab"
        role="tab"
        type="button"
        :aria-selected="t.id === active"
        :aria-controls="`${base}-panel-${t.id}`"
        :tabindex="t.id === active ? 0 : -1"
        :disabled="t.disabled"
        @click="select(t.id)"
      >
        <slot :name="`tab:${t.id}`" :tab="t">{{ t.label }}</slot>
        <span v-if="t.badge !== undefined" class="iu-tabs__badge">{{ t.badge }}</span>
      </button>
      <slot name="trailing" />
    </div>

    <template v-if="panels">
      <div
        v-for="t in tabs"
        :key="t.id"
        v-show="t.id === active"
        :id="`${base}-panel-${t.id}`"
        class="iu-tabs__panel"
        role="tabpanel"
        :aria-labelledby="`${base}-tab-${t.id}`"
        tabindex="0"
      >
        <slot v-if="!lazy || seen.has(t.id)" :name="`panel:${t.id}`" />
      </div>
    </template>
  </div>
</template>

<style>
.iu-tabs {
  display: flex;
  flex-direction: column;
}

.iu-tabs__list {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--iu-hairline);
  padding: 0 8px;
  flex-wrap: wrap;
}

.iu-tabs--vertical .iu-tabs__list {
  flex-direction: column;
  border-bottom: none;
  border-right: 1px solid var(--iu-hairline);
  width: 150px;
  padding: 8px 0;
  background: var(--iu-surface-sunken);
}

.iu-tabs--segmented .iu-tabs__list {
  display: inline-flex;
  border: 1px solid var(--iu-border);
  border-bottom: none;
  padding: 3px;
  border-radius: var(--iu-radius-lg);
  background: var(--iu-well);
  width: fit-content;
  gap: 0;
  flex-wrap: nowrap;
}

.iu-tabs__tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-14);
  padding: 12px 14px;
  border: none;
  background: transparent;
  color: var(--iu-text-2);
  cursor: pointer;
  position: relative;
  font-weight: var(--iu-font-weight-medium);
  text-align: left;
}

.iu-tabs--underline .iu-tabs__tab {
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: 12px 14px;
}

.iu-tabs--underline .iu-tabs__tab[aria-selected='true'] {
  color: var(--iu-text);
  border-bottom-color: var(--iu-accent);
}

.iu-tabs--underline .iu-tabs__tab:hover:not([disabled]) {
  color: var(--iu-text);
}

.iu-tabs--segmented .iu-tabs__tab {
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  padding: 7px 14px;
  border-radius: var(--iu-radius-md);
  gap: 0;
  /* a segmented control stays one row: a container that is too narrow scrolls it rather than wrapping labels */
  white-space: nowrap;
}

.iu-tabs--segmented .iu-tabs__tab[aria-selected='true'] {
  background: var(--iu-raised);
  color: var(--iu-text);
}

.iu-tabs--segmented .iu-tabs__tab:hover:not([disabled]) {
  color: var(--iu-text);
}

.iu-tabs--vertical .iu-tabs__tab {
  font-size: var(--iu-font-size-13);
  padding: 9px 14px;
  border-left: 2px solid transparent;
  margin-left: -2px;
  width: 100%;
  border-radius: 0;
  border-bottom: none;
}

.iu-tabs--vertical .iu-tabs__tab[aria-selected='true'] {
  color: var(--iu-text);
  border-left-color: var(--iu-accent);
  background: var(--iu-raised);
}

.iu-tabs--vertical .iu-tabs__tab:hover:not([disabled]) {
  color: var(--iu-text);
}

.iu-tabs__tab[disabled] {
  color: var(--iu-text-disabled);
  cursor: not-allowed;
}

.iu-tabs__badge {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  padding: 1px 6px;
  border-radius: 9px;
  background: var(--iu-hairline);
  color: var(--iu-text-2);
}

.iu-tabs__panel {
  flex: 1;
  padding: 0;
}

.iu-tabs--vertical {
  display: flex;
}

.iu-tabs--vertical .iu-tabs__list {
  flex: 0 0 auto;
  border-right: 1px solid var(--iu-hairline);
  margin-right: 0;
}

.iu-tabs--vertical .iu-tabs__panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
</style>
