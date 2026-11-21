<script setup lang="ts">
// The session's state in words, in the title row beside the name: the flock, the state word, and one line of what is happening
// (what the open prompt asks, the current tool call, or why it failed). Only a session that needs you or failed is
// tinted; a running one stays calm. Idle and done sessions have no band, the header chip says it.
import { computed, onBeforeUnmount, ref } from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import { lastRunAt } from '@odin/shared/session'
import { IuFlock } from '@/components/Spinner'
import { buildPerch, perchParts } from '@/screens/shared/lanes'
import { SESSION_DISPLAY, relativeTime } from '@/screens/shared/format'
import StatusWord from '@/screens/shared/StatusWord.vue'

const props = defineProps<{
  session: SessionDetail
  /** The turn is over but subagents or commands still run: it reads as running. */
  working?: boolean
}>()

const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)
onBeforeUnmount(() => clearInterval(clock))

const state = computed(() =>
  props.working && props.session.state === 'idle' ? 'running' : props.session.state,
)
const live = computed(() => state.value === 'running' || state.value === 'waiting')
const shown = computed(() => live.value || state.value === 'failed')
const perch = computed(() => (live.value ? buildPerch({ detail: props.session }, now.value) : null))
const parts = computed(() =>
  perch.value
    ? perchParts(perch.value)
    : {
        word: SESSION_DISPLAY.failed.label,
        since: relativeTime(lastRunAt(props.session) ?? '', now.value),
      },
)
const context = computed(() => {
  if (perch.value) return perch.value.activity
  return props.session.error?.trim() || 'The session stopped with an error'
})
const flock = computed(() => (perch.value ? perch.value.flock : 'failed'))
</script>

<template>
  <section v-if="shown" class="status-band" :data-state="state" aria-label="Session status">
    <IuFlock :state="flock" :agents="perch?.agents" size="md" tone="neutral" />
    <div class="status-band__text">
      <StatusWord :word="parts.word" :since="parts.since" />
      <span class="status-band__context" :title="context">{{ context }}</span>
    </div>
  </section>
</template>

<style scoped>
/* Sits in the title row, level with the session name: a quiet run on the row's own background, a tint for the two
   states that need a look (needs you, failed). The context line is what gives way when the window is narrow. */
.status-band {
  display: flex;
  align-items: center;
  gap: 10px;
  /* the squeeze lands here first, so the session name keeps its width */
  flex: 0 4 auto;
  min-width: 0;
  padding: 2px 10px 2px 6px;
  border: 1px solid transparent;
  border-radius: var(--iu-radius-md);
}
.status-band[data-state='waiting'] {
  background: var(--iu-warning-wash);
  border-color: var(--iu-warning-border);
}
.status-band[data-state='failed'] {
  background: var(--iu-danger-wash);
  border-color: var(--iu-danger-border);
}
.status-band__text {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.status-band__context {
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-12-5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
</style>
