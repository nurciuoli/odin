<script setup lang="ts">
import { computed } from 'vue'
import { IuAvatar } from '@/components/Avatar'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import { statusLabel, type Status } from '@/styles/status'

const props = withDefaults(
  defineProps<{
    id: string
    at: Date | string
    type: string
    actor?: { kind: 'person' | 'agent' | 'org'; name: string }
    status?: Status
    title?: string
    description?: string
    body?: string
    metadata?: string
    density?: 'default' | 'compact'
    tz?: string
  }>(),
  { status: 'idle', density: 'default', tz: 'UTC' },
)

const isHuman = computed(() => props.actor?.kind === 'person')
// a person who did something (idle) gets the person marker; any other state shows its status dot
const showPersonMarker = computed(() => isHuman.value && props.status === 'idle')
const dotSize = computed(() => (props.density === 'compact' ? 7 : 9))

const timeFormat = computed(
  () =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: props.tz,
      hour: '2-digit',
      minute: '2-digit',
      second: props.density === 'compact' ? undefined : '2-digit',
      // h23 rather than hour12:false, which some engines render as 24:xx at midnight
      hourCycle: 'h23',
    }),
)

const timeLabel = computed(() =>
  timeFormat.value.format(typeof props.at === 'string' ? new Date(props.at) : props.at),
)
</script>

<template>
  <li class="iu-timeline-event" :class="`is-${status} is-${density}`">
    <div class="iu-timeline-event__timestamp">{{ timeLabel }}</div>
    <div
      class="iu-timeline-event__marker"
      :class="{ 'iu-timeline-event__marker--person': showPersonMarker }"
    >
      <IuStatusDot v-if="!showPersonMarker" :status="status" :size="dotSize" decorative />
      <span class="iu-timeline-event__sr">{{ statusLabel[status] }}</span>
    </div>
    <div class="iu-timeline-event__rail"></div>
    <div class="iu-timeline-event__content">
      <div v-if="actor || title || description" class="iu-timeline-event__header">
        <div v-if="actor" class="iu-timeline-event__actor">
          <IuAvatar
            v-if="isHuman"
            :name="actor.name"
            kind="person"
            :size="20"
            class="iu-timeline-event__avatar"
          />
          <span class="iu-timeline-event__actor-name">{{ actor.name }}</span>
        </div>
        <div v-if="title" class="iu-timeline-event__title">{{ title }}</div>
        <div v-if="description" class="iu-timeline-event__description">{{ description }}</div>
      </div>
      <div v-if="body" class="iu-timeline-event__body">{{ body }}</div>
      <div v-if="metadata" class="iu-timeline-event__metadata">{{ metadata }}</div>
    </div>
  </li>
</template>

<style>
.iu-timeline-event {
  display: flex;
  gap: 0;
  position: relative;
  list-style: none;
  margin: 0;
  padding: 0;
}

.iu-timeline-event__timestamp {
  width: 70px;
  flex: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  text-align: right;
  padding-top: 1px;
  padding-right: 12px;
}

/* the wrapper paints the surface colour so it cuts the rail, and the
   hollow idle/queued dots never show the rail through their middle */
.iu-timeline-event__marker {
  position: relative;
  z-index: 2;
  flex: none;
  width: 9px;
  height: 9px;
  margin-top: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--iu-surface);
  box-shadow: 0 0 0 3px var(--iu-surface);
}

.iu-timeline-event__marker--person {
  background: var(--iu-person-wash);
  border: 1px solid var(--iu-person-border);
}

.iu-timeline-event__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* the marker's centre is at x = 74.5px, so a 1px rail sits at 74px */
.iu-timeline-event__rail {
  position: absolute;
  top: 14px;
  left: 74px;
  width: 1px;
  bottom: 0;
  background: var(--iu-hairline);
  z-index: 1;
}

.iu-timeline-event:last-child .iu-timeline-event__rail {
  display: none;
}

.iu-timeline-event__content {
  flex: 1;
  min-width: 0;
  margin-left: 12px;
  padding-bottom: 20px;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.iu-timeline-event__header {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.iu-timeline-event__actor {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.iu-timeline-event__avatar {
  flex-shrink: 0;
}

.iu-timeline-event__actor-name {
  font-weight: var(--iu-font-weight-medium);
}

.iu-timeline-event__title {
  font-size: var(--iu-font-size-14);
  line-height: var(--iu-leading-normal);
  color: var(--iu-text);
  overflow-wrap: anywhere;
}

.iu-timeline-event__description {
  font-size: var(--iu-font-size-13);
  line-height: var(--iu-leading-normal);
  color: var(--iu-text-2);
}

.iu-timeline-event__body {
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-md);
  background: var(--iu-well);
  padding: 11px 13px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
  line-height: var(--iu-leading-relaxed);
}

.iu-timeline-event__metadata {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}

/* Compact: one row per event. Title and metadata stay visible, the body is dropped. */
/* compact rows top-align so a title that wraps (narrow side panels) keeps
   its time and marker on the first line */
.iu-timeline-event.is-compact {
  align-items: flex-start;
  padding: 5px 0;
  gap: 10px;
}

.iu-timeline-event.is-compact .iu-timeline-event__timestamp {
  width: 44px;
  padding: 0;
  line-height: 19px;
}

.iu-timeline-event.is-compact .iu-timeline-event__marker {
  width: 7px;
  height: 7px;
  margin-top: 6px;
}

.iu-timeline-event.is-compact .iu-timeline-event__rail {
  display: none;
}

.iu-timeline-event.is-compact .iu-timeline-event__content {
  margin-left: 0;
  padding-bottom: 0;
  column-gap: 10px;
  row-gap: 1px;
  flex-direction: row;
  flex-wrap: wrap;
  align-items: baseline;
  min-width: 0;
}

/* actor + title flow as one line of text and wrap together, clamped at two lines */
.iu-timeline-event.is-compact .iu-timeline-event__header {
  flex: 1 1 140px;
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  font-size: var(--iu-font-size-13);
  line-height: 19px;
}

.iu-timeline-event.is-compact .iu-timeline-event__actor {
  display: inline-flex;
  vertical-align: top;
  margin-right: 6px;
  flex-wrap: nowrap;
}

.iu-timeline-event.is-compact .iu-timeline-event__title {
  display: inline;
}

.iu-timeline-event.is-compact .iu-timeline-event__description,
.iu-timeline-event.is-compact .iu-timeline-event__body {
  display: none;
}

.iu-timeline-event.is-compact .iu-timeline-event__metadata {
  flex: none;
  white-space: nowrap;
  font-size: var(--iu-font-size-11-5);
}
</style>
