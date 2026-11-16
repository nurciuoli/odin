<script setup lang="ts">
// IuFilterBar.vue
// The bundle's extracted source is only the reactive core — clause/query
// state, the derived `applied` list, and the URL-sync watchEffect — with no
// <template>/<style> at all. That script is kept exactly as given below
// (only fix: `watchEffect` was used but never imported). Everything else —
// the chips row, the "+ Filter" / saved-views menus, the chip editor
// popover, and the FieldDef/SavedView types it all depends on but that were
// never defined in the extract — is new, real implementation built to the
// API table + the "Assembled", "Chip editor" and "Operators & saved views"
// mockup sections.
import { computed, nextTick, onMounted, onUnmounted, ref, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IuIcon } from '@/components/Icon'
import { IuButton } from '@/components/Button'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuCheckbox } from '@/components/Fields'

export type Op =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'before'
  | 'after'
  | 'gt'
  | 'lt'
  | 'between'
  | 'empty'
  | 'inLast'
export interface Clause {
  key: string
  op: Op
  value: unknown | null
}

export type FieldType = 'enum' | 'reference' | 'text' | 'date' | 'number'
export interface FieldOption {
  value: string
  label: string
}
export interface FieldDef {
  key: string
  label: string
  type: FieldType
  options?: FieldOption[]
}
export interface SavedView {
  id: string
  label: string
  count?: number
  /** renders a small status dot next to the count, e.g. a view that's over a threshold */
  intent?: 'warning' | 'danger' | 'positive' | null
  /** the filter state this view restores when picked */
  q?: string
  clauses?: Clause[]
}

const clauses = defineModel<Clause[]>({ default: () => [] })
const q = defineModel<string>('q', { default: '' })
const props = withDefaults(
  defineProps<{
    fields: FieldDef[]
    counts?: Record<string, number>
    views?: SavedView[] | null
    syncUrl?: boolean
  }>(),
  { syncUrl: true },
)

// a clause with a null value is 'pending' — it renders dashed and holds its slot
const applied = computed(() => clauses.value.filter(c => c.value !== null))

// url shape: ?q=break&f=status:is:failed,blocked&f=opened:after:2026-09-01
const router = useRouter(),
  route = useRoute()
function serialise(list: Clause[]) {
  return list.map(c =>
    [c.key, c.op, Array.isArray(c.value) ? c.value.join(',') : c.value].join(':'),
  )
}
watchEffect(() => {
  if (!props.syncUrl) return
  router.replace({
    query: { ...route.query, q: q.value || undefined, f: serialise(applied.value) },
  })
})

const emit = defineEmits<{ saveView: [{ q: string; clauses: Clause[] }] }>()

// --- operators per field type, and their display labels ---------------
const OPS_BY_TYPE: Record<FieldType, Op[]> = {
  enum: ['is', 'isNot', 'empty'],
  reference: ['is', 'isNot', 'empty'],
  text: ['contains', 'empty'],
  date: ['before', 'after', 'inLast', 'empty'],
  number: ['gt', 'lt', 'between', 'empty'],
}
const OP_LABEL: Record<Op, string> = {
  is: 'is',
  isNot: 'is not',
  contains: 'contains',
  before: 'before',
  after: 'after',
  gt: '>',
  lt: '<',
  between: 'between',
  empty: 'is empty',
  inLast: 'in last',
}
function fieldFor(key: string): FieldDef | undefined {
  return props.fields.find(f => f.key === key)
}
function isChoiceField(type: FieldType) {
  return type === 'enum' || type === 'reference'
}

// --- free-text search: debounced 200ms before it lands in the `q` model,
// so the URL/consumer isn't re-synced on every keystroke -----------------
const searchDraft = ref(q.value)
watch(q, v => {
  if (v !== searchDraft.value) searchDraft.value = v
})
let searchDebounce: ReturnType<typeof setTimeout> | undefined
watch(searchDraft, v => {
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => {
    q.value = v
  }, 200)
})
function clearSearch() {
  clearTimeout(searchDebounce)
  searchDraft.value = ''
  q.value = ''
}

// --- "+ Filter" menu: pick a field, add a pending clause, open its editor -
const fieldMenuItems = computed<MenuItem[]>(() =>
  props.fields.map(f => ({ id: f.key, label: f.label })),
)
function onFieldMenuSelect(key: string) {
  const field = fieldFor(key)
  if (!field) return
  const index = clauses.value.length
  clauses.value = [
    ...clauses.value,
    { key: field.key, op: OPS_BY_TYPE[field.type][0], value: null },
  ]
  openEditor(index)
}

// --- chip editor: a small popover anchored to the chip it edits ---------
interface Draft {
  index: number
  key: string
  op: Op
  value: unknown
}
const editorOpenFor = ref<number | null>(null)
const draft = ref<Draft | null>(null)

function openEditor(index: number) {
  const c = clauses.value[index]
  if (!c) return
  draft.value = { index, key: c.key, op: c.op, value: c.value }
  editorOpenFor.value = index
}
function closeEditor() {
  editorOpenFor.value = null
  draft.value = null
}
function onOpChange(op: Op) {
  if (!draft.value) return
  draft.value.op = op
  draft.value.value = op === 'empty' ? true : null
}
function applyDraft() {
  if (!draft.value) return
  const { index, key, op, value } = draft.value
  const next = clauses.value.slice()
  next[index] = { key, op, value: op === 'empty' ? true : value }
  clauses.value = next
  closeEditor()
}
// Cancel never removes the clause — a pending chip holds its slot whether or
// not it was just added, per the "holds its slot instead of vanishing" rule.
function cancelDraft() {
  closeEditor()
}
function removeClause(index: number) {
  const next = clauses.value.slice()
  next.splice(index, 1)
  clauses.value = next
  if (editorOpenFor.value === index) closeEditor()
}
function clearAllClauses() {
  clauses.value = []
}

const draftField = computed(() => (draft.value ? fieldFor(draft.value.key) : undefined))

function isOptionChecked(value: string): boolean {
  const v = draft.value?.value
  return Array.isArray(v) && v.includes(value)
}
function toggleOption(value: string) {
  if (!draft.value) return
  const arr: string[] = Array.isArray(draft.value.value) ? [...(draft.value.value as string[])] : []
  const i = arr.indexOf(value)
  if (i === -1) arr.push(value)
  else arr.splice(i, 1)
  draft.value.value = arr.length ? arr : null
}
function setSimpleValue(v: string) {
  if (draft.value) draft.value.value = v === '' ? null : v
}
function setNumberValue(v: string) {
  if (draft.value) draft.value.value = v === '' ? null : Number(v)
}
function betweenPart(i: 0 | 1): string {
  const v = draft.value?.value
  return Array.isArray(v) && v[i] != null ? String(v[i]) : ''
}
function setBetweenPart(i: 0 | 1, raw: string) {
  if (!draft.value) return
  const cur: (number | null)[] = Array.isArray(draft.value.value)
    ? [...draft.value.value]
    : [null, null]
  cur[i] = raw === '' ? null : Number(raw)
  draft.value.value = cur
}
function inLastN(): number {
  const v = draft.value?.value as { n: number; unit: string } | null
  return v?.n ?? 7
}
function inLastUnit(): string {
  const v = draft.value?.value as { n: number; unit: string } | null
  return v?.unit ?? 'days'
}
function setInLast(n: number, unit: string) {
  if (draft.value) draft.value.value = { n, unit }
}

function optionCount(fieldKey: string, value: string): number | undefined {
  return props.counts?.[`${fieldKey}:${value}`]
}

// chip display
function formatValue(c: Clause): string {
  const field = fieldFor(c.key)
  if (c.value == null || c.op === 'empty') return ''
  if (Array.isArray(c.value)) {
    if (c.value.length === 2 && c.op === 'between') return `${c.value[0]}–${c.value[1]}`
    return (c.value as string[])
      .map(v => field?.options?.find(o => o.value === v)?.label ?? v)
      .join(', ')
  }
  if (c.op === 'inLast') {
    const v = c.value as { n: number; unit: string }
    return `${v.n} ${v.unit}`
  }
  return String(c.value)
}
function isMono(field: FieldDef | undefined): boolean {
  return field?.type === 'date' || field?.type === 'number'
}

// --- saved views ----------------------------------------------------------
const activeViewId = ref<string | null>(null)
const viewMenuItems = computed<MenuItem[]>(() => {
  if (!props.views) return []
  const items: MenuItem[] = props.views.map(v => ({ id: v.id, label: v.label }))
  items.push({ type: 'separator' })
  items.push({ id: '__save__', label: 'Save current filters', icon: 'plus' })
  return items
})
function viewById(id: string) {
  return props.views?.find(v => v.id === id)
}
function onViewMenuSelect(id: string) {
  if (id === '__save__') {
    emit('saveView', { q: q.value, clauses: clauses.value })
    return
  }
  const view = viewById(id)
  if (!view) return
  activeViewId.value = view.id
  q.value = view.q ?? ''
  clauses.value = view.clauses ? view.clauses.map(c => ({ ...c })) : []
}
const activeViewLabel = computed(
  () => (activeViewId.value && viewById(activeViewId.value)?.label) || 'Views',
)

// close the chip editor on outside click / Escape (the "+ Filter" and
// "Views" menus manage their own open state via IuMenu already)
const rootEl = ref<HTMLElement | null>(null)
function onDocPointerDown(e: PointerEvent) {
  if (editorOpenFor.value === null) return
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) closeEditor()
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && editorOpenFor.value !== null) closeEditor()
}
onMounted(() => {
  document.addEventListener('pointerdown', onDocPointerDown)
  document.addEventListener('keydown', onDocKeydown)
})
onUnmounted(() => {
  document.removeEventListener('pointerdown', onDocPointerDown)
  document.removeEventListener('keydown', onDocKeydown)
  clearTimeout(searchDebounce)
})

// focus the first meaningful control in the editor once it mounts
const editorFirstInput = ref<HTMLElement | null>(null)
watch(editorOpenFor, async v => {
  if (v === null) return
  await nextTick()
  editorFirstInput.value?.focus()
})
</script>

<template>
  <div ref="rootEl" class="iu-filterbar">
    <div class="iu-filterbar__toolbar">
      <div class="iu-filterbar__search">
        <IuIcon name="search" :size="14" />
        <input
          v-model="searchDraft"
          class="iu-filterbar__search-input"
          type="text"
          placeholder="Search…"
        />
        <button
          v-if="searchDraft"
          type="button"
          class="iu-filterbar__icon-btn"
          aria-label="Clear search"
          @click="clearSearch"
        >
          <IuIcon name="close" :size="14" />
        </button>
      </div>

      <IuMenu :items="fieldMenuItems" placement="bottom-start" @select="onFieldMenuSelect">
        <template #trigger="{ toggle }">
          <IuButton variant="secondary" size="sm" @click="toggle">
            <template #icon><IuIcon name="plus" :size="14" /></template>
            Filter
          </IuButton>
        </template>
      </IuMenu>

      <template v-if="views">
        <div class="iu-filterbar__divider" />
        <IuMenu :items="viewMenuItems" placement="bottom-start" @select="onViewMenuSelect">
          <template #trigger="{ toggle }">
            <IuButton variant="secondary" size="sm" @click="toggle">
              {{ activeViewLabel }}
              <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
            </IuButton>
          </template>
          <template #item="{ item }">
            <span class="iu-filterbar__view-row">
              <span class="iu-filterbar__view-label">{{ item.label }}</span>
              <template v-if="item.id !== '__save__'">
                <span
                  v-if="viewById(item.id)?.intent"
                  class="iu-filterbar__view-dot"
                  :class="`iu-filterbar__view-dot--${viewById(item.id)?.intent}`"
                />
                <span v-if="viewById(item.id)?.count != null" class="iu-filterbar__view-count">{{
                  viewById(item.id)?.count
                }}</span>
              </template>
            </span>
          </template>
        </IuMenu>
      </template>

      <div class="iu-filterbar__toolbar-end"><slot name="toolbar-end" /></div>
    </div>

    <div v-if="clauses.length" class="iu-filterbar__chips">
      <span v-for="(c, i) in clauses" :key="`${c.key}-${i}`" class="iu-filterbar__chip-wrap">
        <span
          class="iu-filterbar__chip"
          :class="{ 'iu-filterbar__chip--pending': c.value === null }"
          role="button"
          tabindex="0"
          @click="openEditor(i)"
          @keydown.enter="openEditor(i)"
        >
          <span class="iu-filterbar__chip-key">{{ fieldFor(c.key)?.label ?? c.key }}</span>
          <span class="iu-filterbar__chip-op">{{ OP_LABEL[c.op] }}</span>
          <span
            v-if="c.value !== null && c.op !== 'empty'"
            class="iu-filterbar__chip-value"
            :class="{ 'iu-filterbar__chip-value--mono': isMono(fieldFor(c.key)) }"
            >{{ formatValue(c) }}</span
          >
          <span
            v-else-if="c.value === null"
            class="iu-filterbar__chip-value iu-filterbar__chip-value--placeholder"
            >…</span
          >
          <button
            type="button"
            class="iu-filterbar__chip-remove"
            aria-label="Remove filter"
            @click.stop="removeClause(i)"
          >
            <IuIcon name="close" :size="14" />
          </button>
        </span>

        <div
          v-if="editorOpenFor === i && draft && draftField"
          class="iu-filterbar__editor"
          @click.stop
        >
          <div class="iu-filterbar__editor-head">
            <span class="iu-filterbar__editor-field">{{ draftField.label }}</span>
            <select
              ref="editorFirstInput"
              class="iu-filterbar__editor-op"
              :value="draft.op"
              @change="onOpChange(($event.target as HTMLSelectElement).value as Op)"
            >
              <option v-for="op in OPS_BY_TYPE[draftField.type]" :key="op" :value="op">
                {{ OP_LABEL[op] }}
              </option>
            </select>
          </div>

          <div class="iu-filterbar__editor-body">
            <template v-if="draft.op === 'empty'">
              <p class="iu-filterbar__editor-note">
                No value needed — matches entries where this field is empty.
              </p>
            </template>

            <template v-else-if="isChoiceField(draftField.type)">
              <IuCheckbox
                v-for="opt in draftField.options ?? []"
                :key="opt.value"
                :model-value="isOptionChecked(opt.value)"
                class="iu-filterbar__editor-option"
                @update:model-value="toggleOption(opt.value)"
              >
                <span class="iu-filterbar__editor-option-row">
                  <span>{{ opt.label }}</span>
                  <span
                    v-if="optionCount(draftField.key, opt.value) != null"
                    class="iu-filterbar__editor-option-count"
                    >{{ optionCount(draftField.key, opt.value) }}</span
                  >
                </span>
              </IuCheckbox>
            </template>

            <template v-else-if="draftField.type === 'text'">
              <input
                class="iu-filterbar__editor-input"
                type="text"
                :value="(draft.value as string) ?? ''"
                @input="setSimpleValue(($event.target as HTMLInputElement).value)"
              />
            </template>

            <template v-else-if="draftField.type === 'date' && draft.op !== 'inLast'">
              <input
                class="iu-filterbar__editor-input"
                type="date"
                :value="(draft.value as string) ?? ''"
                @input="setSimpleValue(($event.target as HTMLInputElement).value)"
              />
            </template>

            <template v-else-if="draftField.type === 'date' && draft.op === 'inLast'">
              <div class="iu-filterbar__editor-inline">
                <input
                  class="iu-filterbar__editor-input iu-filterbar__editor-input--n"
                  type="number"
                  min="1"
                  :value="inLastN()"
                  @input="
                    setInLast(Number(($event.target as HTMLInputElement).value) || 1, inLastUnit())
                  "
                />
                <select
                  class="iu-filterbar__editor-op"
                  :value="inLastUnit()"
                  @change="setInLast(inLastN(), ($event.target as HTMLSelectElement).value)"
                >
                  <option value="days">days</option>
                  <option value="weeks">weeks</option>
                  <option value="months">months</option>
                </select>
              </div>
            </template>

            <template v-else-if="draftField.type === 'number' && draft.op === 'between'">
              <div class="iu-filterbar__editor-inline">
                <input
                  class="iu-filterbar__editor-input"
                  type="number"
                  :value="betweenPart(0)"
                  @input="setBetweenPart(0, ($event.target as HTMLInputElement).value)"
                />
                <span class="iu-filterbar__editor-and">and</span>
                <input
                  class="iu-filterbar__editor-input"
                  type="number"
                  :value="betweenPart(1)"
                  @input="setBetweenPart(1, ($event.target as HTMLInputElement).value)"
                />
              </div>
            </template>

            <template v-else-if="draftField.type === 'number'">
              <input
                class="iu-filterbar__editor-input"
                type="number"
                :value="(draft.value as number) ?? ''"
                @input="setNumberValue(($event.target as HTMLInputElement).value)"
              />
            </template>
          </div>

          <div class="iu-filterbar__editor-foot">
            <IuButton variant="secondary" size="sm" @click="cancelDraft">Cancel</IuButton>
            <IuButton variant="primary" size="sm" @click="applyDraft">Apply</IuButton>
          </div>
        </div>
      </span>

      <button type="button" class="iu-filterbar__clear-all" @click="clearAllClauses">
        Clear all
      </button>
      <span class="iu-filterbar__summary"><slot name="summary" /></span>
    </div>
  </div>
</template>

<style>
.iu-filterbar {
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface);
  overflow: visible;
}

.iu-filterbar__toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 14px;
  flex-wrap: wrap;
}

.iu-filterbar__search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  background: var(--iu-well);
  color: var(--iu-text-muted);
  flex: 1;
  min-width: 200px;
}
.iu-filterbar__search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  font-size: var(--iu-font-size-13-5);
  color: var(--iu-text);
}
.iu-filterbar__search-input::placeholder {
  color: var(--iu-text-muted);
}

.iu-filterbar__icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  padding: 0;
  color: var(--iu-text-muted);
  cursor: pointer;
}
.iu-filterbar__icon-btn:hover {
  color: var(--iu-text);
}

.iu-filterbar__divider {
  width: 1px;
  height: 20px;
  background: var(--iu-hairline);
  flex: none;
}
.iu-filterbar__toolbar-end {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

.iu-filterbar__chips {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 14px 11px;
  flex-wrap: wrap;
}

.iu-filterbar__chip-wrap {
  position: relative;
  display: inline-flex;
}

.iu-filterbar__chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 4px 0 9px;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-accent-wash);
  border: 1px solid var(--iu-accent-border);
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text);
  cursor: pointer;
}
.iu-filterbar__chip--pending {
  background: var(--iu-raised);
  border: 1px dashed var(--iu-border-strong);
  color: var(--iu-text-muted);
}
.iu-filterbar__chip-key {
  color: color-mix(in srgb, var(--iu-accent) 65%, var(--iu-text-2));
}
.iu-filterbar__chip--pending .iu-filterbar__chip-key {
  color: var(--iu-text-muted);
}
.iu-filterbar__chip-op {
  font-family: var(--iu-font-mono);
  color: var(--iu-text-muted);
}
.iu-filterbar__chip-value {
  font-weight: var(--iu-font-weight-medium);
}
.iu-filterbar__chip-value--mono {
  font-family: var(--iu-font-mono);
}
.iu-filterbar__chip-value--placeholder {
  color: var(--iu-text-disabled);
  font-weight: var(--iu-font-weight-regular);
}
.iu-filterbar__chip-remove {
  display: flex;
  align-items: center;
  padding: 2px;
  background: none;
  border: none;
  color: color-mix(in srgb, var(--iu-accent) 65%, var(--iu-text-2));
  cursor: pointer;
}
.iu-filterbar__chip--pending .iu-filterbar__chip-remove {
  color: var(--iu-text-disabled);
}
.iu-filterbar__chip-remove:hover {
  color: var(--iu-text);
}

.iu-filterbar__clear-all {
  height: 26px;
  padding: 0 9px;
  border: none;
  background: none;
  color: var(--iu-text-muted);
  cursor: pointer;
  font: inherit;
  font-size: var(--iu-font-size-12-5);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.iu-filterbar__clear-all:hover {
  color: var(--iu-text);
}
.iu-filterbar__summary {
  margin-left: auto;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}

/* saved-views menu item content (rendered inside IuMenu's #item slot) */
.iu-filterbar__view-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.iu-filterbar__view-label {
  flex: 1;
  min-width: 0;
}
.iu-filterbar__view-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
}
.iu-filterbar__view-dot--warning {
  background: var(--iu-warning);
}
.iu-filterbar__view-dot--danger {
  background: var(--iu-danger);
}
.iu-filterbar__view-dot--positive {
  background: var(--iu-positive);
}
.iu-filterbar__view-count {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  flex: none;
}

/* chip editor popover */
.iu-filterbar__editor {
  position: absolute;
  top: 100%;
  left: 0;
  margin-top: 6px;
  width: 260px;
  background: var(--iu-raised);
  border: 1px solid var(--iu-border-strong);
  border-radius: var(--iu-radius-lg);
  box-shadow: var(--iu-shadow-popover);
  overflow: hidden;
  z-index: 20;
  cursor: default;
}
.iu-filterbar__editor-head {
  padding: 9px 12px;
  border-bottom: 1px solid var(--iu-border);
  display: flex;
  align-items: center;
  gap: 8px;
}
.iu-filterbar__editor-field {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
}
.iu-filterbar__editor-op {
  margin-left: auto;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  background: var(--iu-well);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  padding: 2px 5px;
}
.iu-filterbar__editor-body {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 220px;
  overflow-y: auto;
}
.iu-filterbar__editor-option {
  padding: 6px 4px;
  border-radius: var(--iu-radius-sm);
}
.iu-filterbar__editor-option:hover {
  background: var(--iu-surface);
}
.iu-filterbar__editor-option-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  font-size: var(--iu-font-size-13-5);
}
.iu-filterbar__editor-option-row > span:first-child {
  flex: 1;
}
.iu-filterbar__editor-option-count {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}
.iu-filterbar__editor-note {
  margin: 4px;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
  line-height: var(--iu-leading-relaxed);
}
.iu-filterbar__editor-input {
  width: 100%;
  height: 28px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  background: var(--iu-well);
  color: var(--iu-text);
  font: inherit;
  font-size: var(--iu-font-size-13);
  padding: 0 8px;
}
.iu-filterbar__editor-inline {
  display: flex;
  align-items: center;
  gap: 8px;
}
.iu-filterbar__editor-input--n {
  width: 64px;
  flex: none;
}
.iu-filterbar__editor-and {
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
  flex: none;
}
.iu-filterbar__editor-foot {
  display: flex;
  gap: 8px;
  padding: 9px 12px;
  border-top: 1px solid var(--iu-border);
}
.iu-filterbar__editor-foot > * {
  flex: 1;
}
</style>
