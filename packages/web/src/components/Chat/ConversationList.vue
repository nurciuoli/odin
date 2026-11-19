<script setup lang="ts">
// IuConversationList — the chat history column. Rows reuse the sidebar's
// selection language (raised row + 2px ember marker, hover tint) so the two
// columns read as one system. Grouping and relative times are computed
// against `now` so docs and tests can pin the clock.
import { computed, ref } from 'vue'
import { useNow } from '@/composables/useNow'
import IuEyebrow from '@/components/Eyebrow/Eyebrow.vue'
import IuField from '@/components/Fields/Field.vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import type { Conversation } from '@/components/Chat/types'

const props = withDefaults(
  defineProps<{
    conversations: Conversation[]
    searchable?: boolean
    /** ISO reference time for grouping and relative labels; defaults to useNow() */
    now?: string
  }>(),
  { searchable: true },
)

const active = defineModel<string>('active')
const query = defineModel<string>('query', { default: '' })
const emit = defineEmits<{ select: [id: string] }>()

const bodyRef = ref<HTMLElement | null>(null)
// last row the user moved focus to; keeps the roving tab stop where they left it
const focusId = ref<string | null>(null)

const clock = useNow()
const nowDate = computed(() => new Date(props.now ?? clock()))

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY_MS = 86_400_000

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

// calendar days between the reference day and the timestamp's day (DST-safe)
function daysAgo(iso: string): number {
  return Math.round((startOfDay(nowDate.value.getTime()) - startOfDay(Date.parse(iso))) / DAY_MS)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function timeLabel(iso: string): string {
  const d = new Date(iso)
  const ago = daysAgo(iso)
  if (ago <= 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (ago === 1) return 'Yest'
  if (ago <= 7) return WEEKDAYS[d.getDay()]
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`
}

const GROUPS = [
  { id: 'pinned', label: 'Pinned' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'week', label: 'Previous 7 days' },
  { id: 'older', label: 'Older' },
] as const
type GroupId = (typeof GROUPS)[number]['id']

const needle = computed(() => query.value.trim().toLowerCase())

const matches = computed(() => {
  if (!needle.value) return props.conversations
  return props.conversations.filter(
    c =>
      c.title.toLowerCase().includes(needle.value) ||
      (c.preview ?? '').toLowerCase().includes(needle.value),
  )
})

const groups = computed(() => {
  const buckets: Record<GroupId, Conversation[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    week: [],
    older: [],
  }
  for (const c of matches.value) {
    if (c.pinned) {
      buckets.pinned.push(c)
      continue
    }
    const ago = daysAgo(c.updatedAt)
    const id: GroupId = ago <= 0 ? 'today' : ago === 1 ? 'yesterday' : ago <= 7 ? 'week' : 'older'
    buckets[id].push(c)
  }
  const recentFirst = (a: Conversation, b: Conversation) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  return GROUPS.map(g => ({ ...g, items: buckets[g.id].sort(recentFirst) })).filter(
    g => g.items.length > 0,
  )
})

// exactly one row is in the tab order: focus, else the selection, else the first row
const tabStopId = computed(() => {
  const ids = new Set(matches.value.map(c => c.id))
  if (focusId.value && ids.has(focusId.value)) return focusId.value
  if (active.value && ids.has(active.value)) return active.value
  return matches.value[0]?.id
})

function select(id: string) {
  active.value = id
  emit('select', id)
}

function onFocusIn(e: FocusEvent) {
  const id = (e.target as HTMLElement).dataset?.id
  if (id) focusId.value = id
}

function onKeydown(e: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
  const rows = Array.from(bodyRef.value?.querySelectorAll<HTMLButtonElement>('.iu-conv') ?? [])
  const i = rows.indexOf(e.target as HTMLButtonElement)
  if (i < 0) return
  const last = rows.length - 1
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? last
        : e.key === 'ArrowDown'
          ? Math.min(i + 1, last)
          : Math.max(i - 1, 0)
  e.preventDefault()
  rows[next]?.focus()
}
const topRef = ref<HTMLElement | null>(null)

/** focus the search field — for a consumer opening the list on a user action */
function focusSearch() {
  topRef.value?.querySelector<HTMLInputElement>('input')?.focus()
}
defineExpose({ focusSearch })
</script>

<template>
  <nav class="iu-conv-list" aria-label="Conversations">
    <div v-if="searchable || $slots.header" ref="topRef" class="iu-conv-list__top">
      <slot name="header" />
      <IuField
        v-if="searchable"
        label="Search conversations"
        hide-label
        size="sm"
        type="search"
        placeholder="Search"
        :model-value="query"
        @update:model-value="query = String($event)"
      >
        <template #prefix>
          <IuIcon name="search" :size="14" />
        </template>
      </IuField>
    </div>

    <div ref="bodyRef" class="iu-conv-list__body" @keydown="onKeydown" @focusin="onFocusIn">
      <template v-if="groups.length">
        <div
          v-for="g in groups"
          :key="g.id"
          class="iu-conv-list__group"
          role="group"
          :aria-label="g.label"
        >
          <IuEyebrow class="iu-conv-list__heading">{{ g.label }}</IuEyebrow>
          <button
            v-for="c in g.items"
            :key="c.id"
            type="button"
            class="iu-conv"
            :class="{ 'is-active': c.id === active, 'is-unread': c.unread }"
            :data-id="c.id"
            :aria-current="c.id === active ? 'true' : undefined"
            :tabindex="c.id === tabStopId ? 0 : -1"
            @click="select(c.id)"
          >
            <IuStatusDot :status="c.status" :size="7" />
            <span class="iu-conv__title">{{ c.title }}</span>
            <time class="iu-conv__time" :datetime="c.updatedAt">{{ timeLabel(c.updatedAt) }}</time>
            <span v-if="c.preview" class="iu-conv__preview">{{ c.preview }}</span>
          </button>
        </div>
      </template>
      <p v-else-if="conversations.length && needle" class="iu-conv-list__none">
        No conversations match “{{ query.trim() }}”
      </p>
      <div v-else-if="!conversations.length" class="iu-conv-list__none">
        <slot name="empty">No conversations yet</slot>
      </div>
    </div>
  </nav>
</template>

<style>
/* fills its column: header and search stay put, only the list scrolls */
.iu-conv-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.iu-conv-list__top {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 8px 4px;
}

.iu-conv-list__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 10px;
}

.iu-conv-list__group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.iu-conv-list__heading {
  padding: 12px 10px 6px;
}

.iu-conv {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  column-gap: 8px;
  row-gap: 2px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: var(--iu-radius-md);
  background: none;
  color: var(--iu-text-2);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  text-align: left;
  cursor: pointer;
}
.iu-conv:hover {
  background: var(--iu-hover);
  color: var(--iu-text);
}
.iu-conv:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: calc(var(--iu-focus-offset) * -1);
}

/* selection = raised row + 2px ember marker, same as IuNavItem */
.iu-conv.is-active {
  background: var(--iu-raised);
  color: var(--iu-text);
}
.iu-conv.is-active::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 7px;
  bottom: 7px;
  width: 2px;
  border-radius: 0 2px 2px 0;
  background: var(--iu-accent);
}

.iu-conv__title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  line-height: var(--iu-leading-snug);
}
.iu-conv.is-active .iu-conv__title {
  font-weight: var(--iu-font-weight-medium);
}
.iu-conv.is-unread .iu-conv__title {
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text);
}

.iu-conv__time {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  font-variant-numeric: tabular-nums;
  color: var(--iu-text-muted);
  white-space: nowrap;
}

.iu-conv__preview {
  grid-column: 2 / 4;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text-muted);
}

.iu-conv-list__none {
  margin: 0;
  padding: 12px 10px;
  font-size: var(--iu-font-size-12-5);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text-muted);
}
</style>
