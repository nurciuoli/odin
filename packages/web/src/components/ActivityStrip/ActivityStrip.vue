<script setup lang="ts">
import { computed, nextTick, onBeforeUpdate, ref, watch } from 'vue'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuStatusDot } from '@/components/StatusDot'
import { IuFlock } from '@/components/Spinner'
import type { Status } from '@/styles/status'

export interface ActivityItem {
  id: string
  label: string
  kind: string
  status: Status
  state: string
  time?: string
  summary?: string
  dismissible: boolean
}
const props = withDefaults(
  defineProps<{
    items: ActivityItem[]
    /** Subagents running now: dots that circle the flock beside the title. The counts still say it in words. */
    agents?: number
  }>(),
  { agents: 0 },
)
const running = computed(() => props.items.some(item => item.status === 'running'))
const emit = defineEmits<{
  select: [id: string]
  dismiss: [id: string]
  focus: [id: string | null]
}>()
const expanded = ref(false)
const root = ref<HTMLElement>()
const focused = ref(false)
const order = ref<string[]>([])
onBeforeUpdate(() => {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !root.value?.contains(active)) return
  const id = active.closest<HTMLElement>('[data-activity-id]')?.dataset.activityId
  if (id && !props.items.some(item => item.id === id) && props.items.length) {
    root.value.querySelector<HTMLButtonElement>('.iu-activity-strip__toggle')?.focus()
  }
})
watch(
  () => props.items.map(i => i.id),
  ids => {
    if (!focused.value) order.value = ids
  },
  { immediate: true },
)
const rows = computed(() =>
  focused.value
    ? [...props.items].sort((a, b) => {
        const rank = (id: string) =>
          order.value.includes(id) ? order.value.indexOf(id) : order.value.length
        return rank(a.id) - rank(b.id)
      })
    : props.items,
)
const counts = computed(() => {
  const states = new Map<string, number>()
  for (const item of props.items) states.set(item.state, (states.get(item.state) ?? 0) + 1)
  return [...states].map(([state, count]) => `${count} ${state}`).join(' · ')
})
function onFocus(event: FocusEvent) {
  focused.value = true
  const row = (event.target as Element)?.closest<HTMLElement>('[data-activity-id]')
  // Protect one item while the disclosure owns focus so expiry cannot unmount its button.
  emit('focus', row?.dataset.activityId ?? props.items[0]?.id ?? null)
}
async function onBlur() {
  await nextTick()
  if (root.value?.contains(document.activeElement)) return
  focused.value = false
  order.value = props.items.map(i => i.id)
  emit('focus', null)
}
</script>
<template>
  <section
    ref="root"
    class="iu-activity-strip"
    aria-label="Session activity"
    @focusin="onFocus"
    @focusout="onBlur"
  >
    <button
      class="iu-activity-strip__toggle"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>Activity</span><IuFlock v-if="running" :agents="agents" /><span
        class="iu-activity-strip__counts"
        >{{ counts }}</span
      >
      <IuIcon name="chevronDown" :size="14" :class="{ 'iu-activity-strip__up': expanded }" />
    </button>
    <div v-if="expanded" class="iu-activity-strip__rows">
      <div
        v-for="item in rows"
        :key="item.id"
        class="iu-activity-strip__row"
        :data-activity-id="item.id"
      >
        <button class="iu-activity-strip__select" @click="emit('select', item.id)">
          <IuStatusDot :status="item.status" decorative />
          <span class="iu-activity-strip__description"
            ><span class="iu-activity-strip__label">{{ item.label }}</span
            ><span v-if="item.summary" class="iu-activity-strip__summary">{{
              item.summary
            }}</span></span
          >
          <span class="iu-activity-strip__metadata"
            >{{ item.kind }} · {{ item.state
            }}<span v-if="item.time"> · {{ item.time }}</span></span
          >
        </button>
        <IuButton
          v-if="item.dismissible"
          variant="ghost"
          size="sm"
          icon-only
          :aria-label="`Dismiss ${item.label} from activity`"
          @click="emit('dismiss', item.id)"
          ><template #icon><IuIcon name="close" :size="14" /></template
        ></IuButton>
      </div>
    </div>
  </section>
</template>
<style>
.iu-activity-strip {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  color: var(--iu-text);
  font-size: var(--iu-font-size-12);
}
.iu-activity-strip__toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  box-sizing: border-box;
  padding: 8px 12px;
  background: transparent;
  color: inherit;
  border: 0;
  cursor: pointer;
  font: inherit;
}
.iu-activity-strip__counts {
  flex: 1;
  text-align: right;
  color: var(--iu-text-muted);
}
.iu-activity-strip__rows {
  max-height: min(180px, 24vh);
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
}
.iu-activity-strip__up {
  transform: rotate(180deg);
}
.iu-activity-strip__row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 8px;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
}
.iu-activity-strip__select {
  display: flex;
  flex: 1;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  box-sizing: border-box;
  gap: 8px;
  border: 0;
  padding: 10px 12px;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.iu-activity-strip__description {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
.iu-activity-strip__label,
.iu-activity-strip__summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  max-width: 100%;
}
.iu-activity-strip__metadata {
  flex: none;
  white-space: nowrap;
}
.iu-activity-strip__summary,
.iu-activity-strip__metadata {
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11);
}
.iu-activity-strip__toggle:hover,
.iu-activity-strip__select:hover {
  background: var(--iu-raised);
}
.iu-activity-strip button:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
@media (max-width: 600px) {
  .iu-activity-strip__select {
    flex-wrap: wrap;
  }
  .iu-activity-strip__metadata {
    width: 100%;
    padding-left: 16px;
  }
}
</style>
