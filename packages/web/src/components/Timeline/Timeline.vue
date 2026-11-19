<script setup lang="ts">
import { computed, ref } from 'vue'
import { useNow } from '@/composables/useNow'
import IuTimelineEvent from './TimelineEvent.vue'
import IuEyebrow from '@/components/Eyebrow/Eyebrow.vue'
import type { Status } from '@/styles/status'

export interface TimelineEventData {
  id: string
  at: Date | string
  type: string
  actor?: { kind: 'person' | 'agent' | 'org'; name: string }
  status?: Status
  title?: string
  description?: string
  body?: string
  metadata?: string
}

interface Row {
  key: string
  type: string
  day: string
  newDay: boolean
  items: TimelineEventData[]
}

const props = withDefaults(
  defineProps<{
    events: TimelineEventData[]
    density?: 'default' | 'compact'
    collapseAfter?: number
    tz?: string
  }>(),
  { density: 'default', collapseAfter: 5, tz: 'UTC' },
)

// the user's fold toggles only; absent keys fall back to the length default
const collapsedState = ref<Record<string, boolean>>({})

function toDate(at: Date | string): Date {
  return typeof at === 'string' ? new Date(at) : at
}

// YYYY-MM-DD in the display zone, so day grouping follows tz rather than the viewer's clock
function dayKeyOf(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: props.tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

const now = useNow()

function dayLabel(d: Date): string {
  const short = new Intl.DateTimeFormat('en-GB', {
    timeZone: props.tz,
    day: 'numeric',
    month: 'short',
  }).format(d)
  const key = dayKeyOf(d)
  if (key === dayKeyOf(new Date(now()))) return `Today · ${short}`
  if (key === dayKeyOf(new Date(now() - 86_400_000))) return 'Yesterday'
  return short
}

const timeFormat = computed(
  () =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: props.tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }),
)

// consecutive runs of the same type fold into one row once they pass collapseAfter
const groups = computed<Row[]>(() => {
  const out: Row[] = []
  let lastDay = ''

  for (const e of props.events) {
    const d = toDate(e.at)
    const day = dayKeyOf(d)
    const newDay = day !== lastDay
    lastDay = day

    const prev = out.at(-1)
    if (prev && prev.type === e.type && !newDay) {
      prev.items.push(e)
      continue
    }

    out.push({ key: e.id, type: e.type, day: dayLabel(d), newDay, items: [e] })
  }

  return out
})

function isCollapsed(row: Row): boolean {
  return collapsedState.value[row.key] ?? row.items.length > props.collapseAfter
}

function toggle(row: Row) {
  collapsedState.value[row.key] = !isCollapsed(row)
}
</script>

<template>
  <ol class="iu-timeline" :class="`is-${density}`">
    <template v-for="g in groups" :key="g.key">
      <li v-if="g.newDay" class="iu-timeline__day">
        <IuEyebrow>{{ g.day }}</IuEyebrow>
      </li>
      <IuTimelineEvent
        v-for="e in isCollapsed(g) ? [] : g.items"
        :key="e.id"
        v-bind="e"
        :density="density"
        :tz="tz"
      />
      <li v-if="g.items.length > collapseAfter" class="iu-timeline__fold">
        <button
          type="button"
          class="iu-timeline__fold-button"
          :aria-expanded="isCollapsed(g) ? 'false' : 'true'"
          @click="toggle(g)"
        >
          <span class="iu-timeline__fold-time">{{
            isCollapsed(g) ? timeFormat.format(toDate(g.items[0].at)) : ''
          }}</span>
          <span class="iu-timeline__fold-marker" aria-hidden="true"></span>
          <span class="iu-timeline__fold-text">
            {{ g.items.length }} {{ g.type }} events · {{ isCollapsed(g) ? 'show' : 'hide' }}
          </span>
        </button>
      </li>
    </template>
  </ol>
</template>

<style>
.iu-timeline {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
}

.iu-timeline__day {
  list-style: none;
  padding: 0 0 12px 82px;
  margin: 0;
}

.iu-timeline__fold {
  list-style: none;
  margin: 0;
  padding: 0;
}

.iu-timeline__fold-button {
  display: flex;
  align-items: center;
  width: 100%;
  margin: 0;
  padding: 5px 0;
  border: 0;
  border-radius: 0;
  background: none;
  font: inherit;
  color: var(--iu-text-muted);
  text-align: left;
  cursor: pointer;
}

.iu-timeline__fold-button:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}

.iu-timeline__fold-time {
  width: 70px;
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  text-align: right;
  padding-right: 12px;
  padding-top: 1px;
}

.iu-timeline__fold-marker {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 1px dashed var(--iu-text-disabled);
  flex: none;
  margin-right: 10px;
}

.iu-timeline__fold-text {
  min-width: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}

.iu-timeline__fold-button:hover .iu-timeline__fold-text {
  color: var(--iu-text-2);
}

/* Compact mode */
.iu-timeline.is-compact {
  gap: 0;
}

.iu-timeline.is-compact .iu-timeline__day {
  display: none;
}
</style>
