<script setup lang="ts" generic="T">
// IuSelect.vue — the one flexible surface documented by the bundle: a
// grouped select, a filtering combobox, a multi-select with chips, and an
// async/creatable lookup are all this same component, driven by props.
// useListbox() owns the state; this file only renders it.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'
import { IuIcon } from '@/components/Icon'
import { useListbox } from './useListbox'

const props = withDefaults(
  defineProps<{
    options: T[] | ((query: string) => Promise<T[]>)
    multiple?: boolean
    groupBy?: (option: T) => string
    creatable?: boolean
    placeholder?: string
    disabled?: boolean
    /** accessible name for the trigger when no visible <label for> points at it */
    ariaLabel?: string
    /** id of the visible label element, e.g. a field label */
    ariaLabelledby?: string
    /** `sm`: a compact trigger the height of a md button, for toolbars and headers */
    size?: 'sm' | 'md'
    /** a plain right-aligned value that shows its border on hover and focus, for dense rows */
    quiet?: boolean
  }>(),
  {
    size: 'md',
    quiet: false,
    multiple: false,
    creatable: false,
    placeholder: 'Select…',
    disabled: false,
  },
)

const emit = defineEmits<{ create: [string] }>()

const selected = defineModel<T[]>('selected', { default: () => [] })

// default identity/label extraction: an `id`/`value` field on objects, the
// primitive value itself otherwise — good enough for typical option shapes,
// callers needing something bespoke can shape their `options` accordingly.
function keyOf(option: T): string | number {
  if (option === null || option === undefined) return String(option)
  if (typeof option === 'string' || typeof option === 'number') return option
  const rec = option as Record<string, unknown>
  if (typeof rec.id === 'string' || typeof rec.id === 'number') return rec.id
  if (typeof rec.value === 'string' || typeof rec.value === 'number') return rec.value
  return JSON.stringify(option)
}

function labelOf(option: T): string {
  if (option === null || option === undefined) return ''
  if (typeof option === 'string' || typeof option === 'number') return String(option)
  const rec = option as Record<string, unknown>
  for (const field of ['label', 'name', 'title']) {
    if (typeof rec[field] === 'string') return rec[field] as string
  }
  return String(keyOf(option))
}

const staticOptions = computed(() =>
  typeof props.options === 'function' ? [] : props.options,
) as Ref<T[]>

// sync vs async mode and `multiple` are fixed at setup by design — a Select doesn't switch between them
// eslint-disable-next-line vue/no-setup-props-reactivity-loss
const list = useListbox<T>({
  options: typeof props.options === 'function' ? props.options : staticOptions,
  multiple: props.multiple,
  key: keyOf,
  selected,
})

const uid = crypto.randomUUID().slice(0, 8)
const root = ref<HTMLElement | null>(null)
const searchInput = ref<HTMLInputElement | null>(null)

const activeOption = computed(() => list.visible.value[list.activeIndex.value])
const activeId = computed(() =>
  activeOption.value !== undefined ? `${uid}-opt-${keyOf(activeOption.value)}` : undefined,
)

const totalCount = computed(() =>
  typeof props.options === 'function' ? list.visible.value.length : (props.options as T[]).length,
)

const groups = computed(() => {
  if (!props.groupBy) return [{ label: null as string | null, options: list.visible.value }]
  const order: string[] = []
  const map = new Map<string, T[]>()
  for (const o of list.visible.value) {
    const g = props.groupBy(o)
    if (!map.has(g)) {
      map.set(g, [])
      order.push(g)
    }
    map.get(g)!.push(o)
  }
  return order.map(label => ({ label, options: map.get(label)! }))
})

function indexOf(option: T): number {
  return list.visible.value.findIndex(o => keyOf(o) === keyOf(option))
}

function onTriggerClick() {
  if (props.disabled) return
  list.toggle()
}

function onOpen() {
  if (props.disabled) return
  list.openList()
}

function onCreate() {
  const q = list.query.value.trim()
  if (!q) return
  emit('create', q)
  list.close()
}

function onOutside(e: PointerEvent) {
  if (root.value && !root.value.contains(e.target as Node)) list.close()
}

onMounted(() => document.addEventListener('pointerdown', onOutside))
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside))

watch(list.open, isOpen => {
  if (isOpen) nextTick(() => searchInput.value?.focus())
})
</script>

<template>
  <div
    ref="root"
    class="iu-select"
    :class="{
      'iu-select--disabled': disabled,
      'iu-select--multiple': multiple,
      'iu-select--open': list.open.value,
      'iu-select--sm': size === 'sm',
      'iu-select--quiet': quiet,
    }"
  >
    <button
      v-if="!multiple"
      type="button"
      class="iu-select__trigger"
      role="combobox"
      aria-haspopup="listbox"
      :aria-expanded="list.open.value"
      :aria-activedescendant="activeId"
      :aria-controls="`${uid}-panel`"
      :aria-label="ariaLabel"
      :aria-labelledby="ariaLabelledby"
      :disabled="disabled"
      @click="onTriggerClick"
      @keydown="list.onKeydown"
    >
      <span class="iu-select__value">
        <slot name="value" :selected="list.selected.value">
          <span v-if="!list.selected.value.length" class="iu-select__placeholder">{{
            placeholder
          }}</span>
          <span v-else>{{ list.selected.value.map(labelOf).join(', ') }}</span>
        </slot>
      </span>
      <IuIcon
        name="chevronDown"
        :size="14"
        class="iu-select__chevron"
        :class="{ 'iu-select__chevron--open': list.open.value }"
      />
    </button>

    <div
      v-else
      class="iu-select__trigger iu-select__trigger--tokens"
      role="combobox"
      tabindex="0"
      aria-haspopup="listbox"
      :aria-expanded="list.open.value"
      :aria-activedescendant="activeId"
      :aria-controls="`${uid}-panel`"
      :aria-label="ariaLabel"
      :aria-labelledby="ariaLabelledby"
      :aria-disabled="disabled || undefined"
      @click="onOpen"
      @keydown="list.onKeydown"
    >
      <slot name="value" :selected="list.selected.value">
        <span v-for="o in list.selected.value" :key="keyOf(o)" class="iu-select__chip">
          {{ labelOf(o) }}
          <button
            type="button"
            class="iu-select__chip-remove"
            :aria-label="`Remove ${labelOf(o)}`"
            @click.stop="list.remove(o)"
          >
            <IuIcon name="close" :size="14" />
          </button>
        </span>
        <span v-if="!list.selected.value.length" class="iu-select__placeholder">{{
          placeholder
        }}</span>
      </slot>
    </div>

    <div
      v-if="list.open.value"
      :id="`${uid}-panel`"
      class="iu-select__panel"
      role="listbox"
      :aria-multiselectable="multiple || undefined"
    >
      <div class="iu-select__search">
        <IuIcon name="search" :size="14" />
        <input
          ref="searchInput"
          v-model="list.query.value"
          type="text"
          class="iu-select__search-input"
          placeholder="Search…"
          @keydown="list.onKeydown"
        />
        <span v-if="list.query.value" class="iu-select__count"
          >{{ list.visible.value.length }} of {{ totalCount }}</span
        >
      </div>

      <div v-if="list.pending.value" class="iu-select__loading">
        <span class="iu-select__spinner" aria-hidden="true" />
        <span>Loading…</span>
      </div>

      <div v-else class="iu-select__list">
        <template v-for="group in groups" :key="group.label ?? '__all'">
          <div v-if="group.label" class="iu-select__group-label">
            <slot name="group-label" :group="group.label">{{ group.label }}</slot>
          </div>
          <div
            v-for="o in group.options"
            :id="`${uid}-opt-${keyOf(o)}`"
            :key="keyOf(o)"
            class="iu-select__option"
            role="option"
            :aria-selected="list.isSelected(o)"
            :data-active="indexOf(o) === list.activeIndex.value"
            @click="list.commit(o)"
            @mouseenter="list.activeIndex.value = indexOf(o)"
          >
            <slot name="option" :option="o" :selected="list.isSelected(o)">
              <span v-if="list.isSelected(o)" class="iu-select__option-check"
                ><IuIcon name="check" :size="14"
              /></span>
              <span class="iu-select__option-label">{{ labelOf(o) }}</span>
            </slot>
          </div>
        </template>

        <div v-if="!list.visible.value.length" class="iu-select__empty">
          <slot name="empty">
            <span>No match{{ list.query.value ? ` for "${list.query.value}"` : '' }}</span>
            <span
              v-if="creatable && list.query.value.trim()"
              class="iu-select__create"
              @click="onCreate"
            >
              Create "{{ list.query.value.trim() }}"
            </span>
          </slot>
        </div>
      </div>

      <div v-if="$slots.footer" class="iu-select__footer">
        <slot name="footer" />
      </div>
    </div>
  </div>
</template>

<style>
.iu-select {
  position: relative;
  width: 100%;
}

.iu-select__trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: var(--iu-control-height);
  padding: 10px 12px;
  border-radius: var(--iu-radius-md);
  border: 1px solid var(--iu-border);
  background: var(--iu-well);
  color: var(--iu-text);
  font: inherit;
  font-size: var(--iu-font-size-14);
  cursor: pointer;
  transition:
    border-color 0.12s ease,
    box-shadow 0.12s ease;
}
.iu-select--sm .iu-select__trigger {
  gap: 6px;
  min-height: 30px;
  padding: 4px 10px;
  border-radius: var(--iu-radius-sm);
  font-size: var(--iu-font-size-13);
}
.iu-select__trigger:hover:not(:disabled) {
  border-color: var(--iu-border-strong);
}
.iu-select__trigger:focus-visible {
  outline: none;
  border-color: var(--iu-accent);
}
.iu-select--open .iu-select__trigger {
  border-color: var(--iu-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--iu-accent) 20%, transparent);
}
.iu-select--disabled .iu-select__trigger {
  border-color: var(--iu-hairline);
  background: var(--iu-surface);
  color: var(--iu-text-disabled);
  cursor: not-allowed;
}

.iu-select__value {
  flex: 1;
  min-width: 0;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iu-select__placeholder {
  color: var(--iu-text-muted);
}

.iu-select__chevron {
  flex-shrink: 0;
  color: var(--iu-text-muted);
  transition:
    transform 0.12s ease,
    color 0.12s ease;
}
.iu-select__chevron--open {
  transform: rotate(180deg);
  color: var(--iu-accent);
}

.iu-select__trigger--tokens {
  flex-wrap: wrap;
  height: auto;
  cursor: text;
}

.iu-select__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--iu-font-size-13);
  padding: 4px 8px;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-raised);
  border: 1px solid var(--iu-border);
}
.iu-select__chip-remove {
  display: inline-flex;
  border: none;
  background: none;
  padding: 0;
  margin: 0;
  color: var(--iu-text-muted);
  cursor: pointer;
}
.iu-select__chip-remove:hover {
  color: var(--iu-text);
}

.iu-select__panel {
  position: absolute;
  z-index: 30;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  display: flex;
  flex-direction: column;
  border-radius: var(--iu-radius-lg);
  border: 1px solid var(--iu-border);
  background: var(--iu-raised);
  box-shadow: var(--iu-shadow-raised);
  overflow: hidden;
}

.iu-select__search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--iu-hairline);
  background: var(--iu-well);
  color: var(--iu-text-muted);
  flex-shrink: 0;
}
.iu-select__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  outline: none;
  color: var(--iu-text);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-13);
}
.iu-select__search-input::placeholder {
  color: var(--iu-text-muted);
}
.iu-select__count {
  flex-shrink: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}

.iu-select__list {
  overflow-y: auto;
  max-height: 280px;
}

.iu-select__group-label {
  padding: 10px 14px 6px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.iu-select__group-label:not(:first-child) {
  border-top: 1px solid var(--iu-hairline);
}

.iu-select__option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 14px;
  font-size: var(--iu-font-size-14);
  color: var(--iu-text);
  cursor: pointer;
}
.iu-select__option:hover,
.iu-select__option[data-active='true'] {
  background: color-mix(in srgb, var(--iu-raised), white 8%);
}
.iu-select__option[aria-selected='true'] .iu-select__option-label {
  color: var(--iu-text);
}
.iu-select__option-check {
  display: inline-flex;
  color: var(--iu-accent);
  flex-shrink: 0;
}
.iu-select__option-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.iu-select__loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.iu-select__spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--iu-border) 60%, transparent);
  border-top-color: var(--iu-accent);
  animation: iu-select-spin 0.7s linear infinite;
}
@keyframes iu-select-spin {
  to {
    transform: rotate(360deg);
  }
}

.iu-select__empty {
  padding: 18px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  text-align: center;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.iu-select__create {
  color: var(--iu-accent);
  cursor: pointer;
}
.iu-select__create:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.iu-select__footer {
  display: flex;
  gap: 14px;
  padding: 9px 14px;
  border-top: 1px solid var(--iu-hairline);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  flex-shrink: 0;
}

.iu-select--quiet .iu-select__trigger {
  gap: 4px;
  min-height: 28px;
  padding: 5px 8px;
  border-color: transparent;
  background: transparent;
  border-radius: var(--iu-radius-sm);
  font-size: var(--iu-font-size-13);
}
.iu-select--quiet .iu-select__value {
  text-align: right;
}
.iu-select--quiet .iu-select__trigger:hover:not(:disabled) {
  border-color: var(--iu-hairline);
}
.iu-select--quiet .iu-select__trigger:focus-visible,
.iu-select--quiet.iu-select--open .iu-select__trigger {
  border-color: var(--iu-accent);
  background: var(--iu-well);
  box-shadow: none;
}
</style>
