<script setup lang="ts" generic="T extends Record<string, unknown>">
import { IuCheckbox } from '@/components/Fields'
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue'

export interface Column<T> {
  key: keyof T & string
  header: string
  align?: 'start' | 'end'
  numeric?: boolean
  sortable?: boolean
  /** ascending order for this column when the raw values don't sort meaningfully (e.g. statuses by severity) */
  compare?: (a: T, b: T) => number
  width?: string
}

const props = withDefaults(
  defineProps<{
    columns: Column<T>[]
    rows: T[]
    rowKey: (r: T) => string | number
    selectable?: false | 'single' | 'multi'
    density?: 'compact' | 'comfortable'
    stickyHeader?: boolean
    stickyFirstColumn?: boolean
    maxHeight?: string
    /** Preserve readable columns in a horizontally scrolling table on narrow screens. */
    minWidth?: string
    loading?: boolean
  }>(),
  {
    selectable: false,
    density: 'comfortable',
    stickyHeader: true,
    stickyFirstColumn: false,
    loading: false,
  },
)

const emit = defineEmits<{ 'row-activate': [row: T] }>()

const sort = ref<{ key: string; dir: 'asc' | 'desc' } | null>(null)
const selected = defineModel<Set<string | number>>('selected', { default: () => new Set() })

function isEmpty(v: unknown) {
  return v == null || v === ''
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' })
}

const sorted = computed(() => {
  if (!sort.value) return props.rows
  const { key, dir } = sort.value
  const m = dir === 'asc' ? 1 : -1
  const custom = props.columns.find(c => c.key === key)?.compare
  return props.rows
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      const a = x.r[key]
      const b = y.r[key]
      const ae = isEmpty(a)
      const be = isEmpty(b)
      // empty values always last, regardless of direction
      const c =
        ae || be ? (ae === be ? 0 : ae ? 1 : -1) : (custom ? custom(x.r, y.r) : compare(a, b)) * m
      return c || x.i - y.i
    })
    .map(o => o.r)
})

const allSelected = computed(
  () => props.rows.length > 0 && props.rows.every(r => selected.value.has(props.rowKey(r))),
)
const someSelected = computed(
  () => props.rows.some(r => selected.value.has(props.rowKey(r))) && !allSelected.value,
)

function toggleAllSelected() {
  selected.value =
    allSelected.value || someSelected.value ? new Set() : new Set(props.rows.map(props.rowKey))
}

function toggleRow(row: T) {
  if (!props.selectable) return
  const k = props.rowKey(row)
  if (props.selectable === 'single') {
    selected.value = selected.value.has(k) && selected.value.size === 1 ? new Set() : new Set([k])
    return
  }
  const next = new Set(selected.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  selected.value = next
}

function toggleSort(key: string) {
  if (sort.value?.key !== key) sort.value = { key, dir: 'asc' }
  else if (sort.value.dir === 'asc') sort.value = { key, dir: 'desc' }
  else sort.value = null
}

function ariaSort(col: Column<T>): 'none' | 'ascending' | 'descending' | undefined {
  if (!col.sortable) return undefined
  if (sort.value?.key !== col.key) return 'none'
  return sort.value.dir === 'asc' ? 'ascending' : 'descending'
}

function isSelected(row: T): boolean {
  return !!props.selectable && selected.value.has(props.rowKey(row))
}

// Roving tabindex
const tbodyRef = useTemplateRef<HTMLElement>('tbodyRef')
const active = ref(0)
watch(
  () => sorted.value.length,
  n => {
    if (active.value > n - 1) active.value = Math.max(0, n - 1)
  },
)

function focusRow(i: number) {
  const n = sorted.value.length
  if (!n) return
  active.value = Math.min(n - 1, Math.max(0, i))
  nextTick(() => (tbodyRef.value?.children[active.value] as HTMLElement | undefined)?.focus())
}

function onRowKey(e: KeyboardEvent, row: T, i: number) {
  if (e.target !== e.currentTarget) return // inner controls handle their own keys
  switch (e.key) {
    case 'ArrowDown':
      e.preventDefault()
      focusRow(i + 1)
      break
    case 'ArrowUp':
      e.preventDefault()
      focusRow(i - 1)
      break
    case 'Home':
      e.preventDefault()
      focusRow(0)
      break
    case 'End':
      e.preventDefault()
      focusRow(sorted.value.length - 1)
      break
    case 'PageDown':
      e.preventDefault()
      focusRow(i + 10)
      break
    case 'PageUp':
      e.preventDefault()
      focusRow(i - 10)
      break
    case ' ':
      e.preventDefault()
      toggleRow(row)
      break
    case 'Enter':
      e.preventDefault()
      emit('row-activate', row)
      break
  }
}

function onRowClick(e: MouseEvent, row: T, i: number) {
  active.value = i
  if ((e.target as HTMLElement).closest('input,button,a,select,textarea,label')) return
  toggleRow(row)
}

const skeletonRows = 5
const colCount = computed(() => props.columns.length + (props.selectable === 'multi' ? 1 : 0))
const bodyStyle = computed(() => (props.maxHeight ? { maxHeight: props.maxHeight } : undefined))
</script>

<template>
  <div
    class="iu-table"
    :class="[`iu-table--${density}`, { 'iu-table--stickyCol': stickyFirstColumn }]"
  >
    <div v-if="$slots.toolbar" class="iu-table__toolbar"><slot name="toolbar" /></div>
    <div class="iu-table__scroll" :style="bodyStyle">
      <table
        :style="{ minWidth }"
        role="grid"
        :aria-multiselectable="selectable === 'multi' || undefined"
        :aria-busy="loading || undefined"
      >
        <thead :data-sticky="stickyHeader">
          <tr>
            <th v-if="selectable === 'multi'" class="iu-table__check">
              <IuCheckbox
                :model-value="allSelected"
                :indeterminate="someSelected"
                aria-label="Select all rows"
                @update:model-value="toggleAllSelected"
              />
            </th>
            <th
              v-for="c in columns"
              :key="c.key"
              :style="{ width: c.width }"
              :data-numeric="c.numeric || undefined"
              :data-end="c.align === 'end' || undefined"
              :data-sortable="c.sortable || undefined"
              :aria-sort="ariaSort(c)"
            >
              <button
                v-if="c.sortable"
                type="button"
                class="iu-table__sort"
                @click="toggleSort(c.key)"
              >
                <span>{{ c.header }}</span>
                <span class="iu-table__caret" aria-hidden="true">
                  <svg viewBox="0 0 8 12" width="8" height="12">
                    <path
                      d="M4 1 L7 5 H1 Z"
                      :data-on="(sort?.key === c.key && sort.dir === 'asc') || undefined"
                    />
                    <path
                      d="M4 11 L1 7 H7 Z"
                      :data-on="(sort?.key === c.key && sort.dir === 'desc') || undefined"
                    />
                  </svg>
                </span>
              </button>
              <template v-else>{{ c.header }}</template>
            </th>
          </tr>
        </thead>
        <tbody v-if="loading">
          <tr v-for="n in skeletonRows" :key="n" class="iu-table__skel" aria-hidden="true">
            <td
              v-for="k in colCount"
              :key="k"
              :class="{ 'iu-table__check': selectable === 'multi' && k === 1 }"
            >
              <span
                v-if="!(selectable === 'multi' && k === 1)"
                class="iu-table__bar"
                :style="{ width: `${40 + ((n * 17 + k * 23) % 45)}%` }"
              />
            </td>
          </tr>
        </tbody>
        <tbody v-else ref="tbodyRef">
          <tr
            v-for="(r, i) in sorted"
            :key="rowKey(r)"
            class="iu-table__row"
            :tabindex="i === active ? 0 : -1"
            :data-selected="isSelected(r) || undefined"
            :aria-selected="selectable ? isSelected(r) : undefined"
            @keydown="onRowKey($event, r, i)"
            @click="onRowClick($event, r, i)"
            @dblclick="emit('row-activate', r)"
            @focus="active = i"
          >
            <td v-if="selectable === 'multi'" class="iu-table__check">
              <IuCheckbox
                :model-value="isSelected(r)"
                tabindex="-1"
                :aria-label="`Select row ${rowKey(r)}`"
                @update:model-value="toggleRow(r)"
              />
            </td>
            <td
              v-for="c in columns"
              :key="c.key"
              :data-numeric="c.numeric || undefined"
              :data-end="c.align === 'end' || undefined"
            >
              <slot :name="`cell:${c.key}`" :row="r" :value="r[c.key]">{{ r[c.key] }}</slot>
            </td>
          </tr>
        </tbody>
        <tfoot v-if="$slots.footer">
          <slot name="footer" />
        </tfoot>
      </table>
      <div v-if="!loading && !rows.length" class="iu-table__empty">
        <slot name="empty">No rows to display</slot>
      </div>
    </div>
  </div>
</template>

<style>
.iu-table {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.iu-table__toolbar {
  display: flex;
  align-items: center;
  gap: var(--iu-space-2);
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 1px solid var(--iu-hairline);
}

.iu-table__scroll {
  overflow: auto;
  position: relative;
}

.iu-table table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-family: var(--iu-font-sans);
}

.iu-table thead th,
.iu-table tfoot td {
  background: var(--iu-surface-sunken);
}

.iu-table thead[data-sticky='true'] th {
  position: sticky;
  top: 0;
  z-index: 2;
}

.iu-table th {
  text-align: left;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
  font-weight: var(--iu-font-weight-medium);
  padding: 9px 16px;
  white-space: nowrap;
  border-bottom: 1px solid var(--iu-border-strong);
}
.iu-table th[data-numeric],
.iu-table th[data-end] {
  text-align: right;
}

/* Vertical grid dividers */
.iu-table th:not(:last-child),
.iu-table td:not(:last-child) {
  border-right: 1px solid var(--iu-hairline);
}

.iu-table td {
  font-size: var(--iu-font-size-14);
  padding: 11px 16px;
  text-align: left;
  border-bottom: 1px solid var(--iu-hairline);
  background-color: var(--iu-ground);
}
.iu-table td[data-numeric] {
  font-family: var(--iu-font-mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.iu-table td[data-end] {
  text-align: right;
}

/* Sortable headers */
.iu-table th[data-sortable] {
  padding: 0;
}
.iu-table__sort {
  all: unset;
  box-sizing: border-box;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 9px 16px;
  color: var(--iu-text-muted);
  font: inherit;
  letter-spacing: inherit;
  text-transform: inherit;
}
.iu-table th[data-numeric] .iu-table__sort,
.iu-table th[data-end] .iu-table__sort {
  justify-content: flex-end;
}
.iu-table__sort:hover {
  background: var(--iu-hover);
  color: var(--iu-text);
}
.iu-table__sort:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: -2px;
}
.iu-table th[aria-sort='ascending'] .iu-table__sort,
.iu-table th[aria-sort='descending'] .iu-table__sort {
  color: var(--iu-text);
}
.iu-table__caret {
  display: inline-flex;
}
.iu-table__caret path {
  fill: var(--iu-text-disabled);
}
.iu-table__sort:hover .iu-table__caret path {
  fill: var(--iu-text-muted);
}
.iu-table__caret path[data-on] {
  fill: var(--iu-accent);
}

/* Checkbox column */
.iu-table__check {
  width: 36px;
  padding-left: 16px !important;
  padding-right: 0 !important;
}

/* Rows */
.iu-table__row {
  cursor: default;
}
.iu-table__row:hover td {
  background-color: var(--iu-surface);
}
.iu-table__row:focus {
  outline: none;
}
.iu-table__row:focus-visible td {
  box-shadow:
    inset 0 1px 0 var(--iu-accent),
    inset 0 -1px 0 var(--iu-accent);
}
.iu-table__row:focus-visible td:first-child {
  box-shadow:
    inset 1px 1px 0 var(--iu-accent),
    inset 0 -1px 0 var(--iu-accent);
}
.iu-table__row:focus-visible td:last-child {
  box-shadow:
    inset -1px 1px 0 var(--iu-accent),
    inset 0 -1px 0 var(--iu-accent);
}

/* Selected: wash layered over opaque ground so sticky cells stay opaque */
.iu-table__row[data-selected] td,
.iu-table__row[data-selected]:hover td {
  background-image: linear-gradient(var(--iu-accent-wash), var(--iu-accent-wash));
  color: var(--iu-text);
}
.iu-table__row[data-selected] td:first-child {
  box-shadow: inset 2px 0 0 var(--iu-accent);
}
.iu-table__row[data-selected]:focus-visible td:first-child {
  box-shadow:
    inset 2px 0 0 var(--iu-accent),
    inset 0 1px 0 var(--iu-accent),
    inset 0 -1px 0 var(--iu-accent);
}

/* Sticky first column */
.iu-table--stickyCol th:first-child,
.iu-table--stickyCol td:first-child {
  position: sticky;
  left: 0;
  z-index: 1;
  border-right: 1px solid var(--iu-border);
}
.iu-table--stickyCol thead th:first-child {
  z-index: 3;
}

/* Skeleton */
.iu-table__bar {
  display: block;
  height: 10px;
  border-radius: var(--iu-radius-sm);
  background: linear-gradient(90deg, var(--iu-well), var(--iu-hover), var(--iu-well));
  background-size: 200% 100%;
  animation: iu-table-shimmer 1.2s linear infinite;
}
.iu-table__skel td {
  padding-top: 14px;
  padding-bottom: 14px;
}
@keyframes iu-table-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .iu-table__bar {
    animation: none;
  }
}

.iu-table__empty {
  padding: 32px 16px;
  text-align: center;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
  font-family: var(--iu-font-sans);
}

.iu-table tfoot td {
  padding: 11px 16px;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-semibold);
  border-top: 1px solid var(--iu-border-strong);
  border-bottom: 0;
}

/* Compact */
.iu-table--compact td {
  padding: 6px 14px;
  font-size: var(--iu-font-size-13);
}
.iu-table--compact th {
  padding: 9px 14px;
}
.iu-table--compact th[data-sortable] {
  padding: 0;
}
.iu-table--compact .iu-table__sort {
  padding: 9px 14px;
}
</style>
