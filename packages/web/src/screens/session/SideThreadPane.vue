<script setup lang="ts">
// The workbench's Side view: the open session's side threads, newest first, and the selected one below the list.
// Selecting is the user's own act; a thread that appears (a side question just asked) is selected by the screen
// without moving focus. When the thread focus was in goes away (discarded, promoted, deleted elsewhere), focus moves
// to the pane's heading rather than dropping to the page.
import { computed, nextTick, ref, watch } from 'vue'
import type { Session } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { statusIntent } from '@/styles/status'
import { relativeTime, SESSION_DISPLAY } from '@/screens/shared/format'
import SideThread from './SideThread.vue'
import type { SideThreadsPhase } from './SideThreads'

const props = defineProps<{
  parentId: string
  threads: Session[]
  phase: SideThreadsPhase
  error?: string | null
  /** Entry ids of the parent's transcript (see SideThread). */
  parentEntryIds?: ReadonlySet<string>
}>()
const selected = defineModel<string | null>('selected', { default: null })
const emit = defineEmits<{ retry: []; promoted: [session: Session]; discarded: [id: string] }>()

// the selection, or the newest thread when nothing (or something gone) is selected
const current = computed(
  () => props.threads.find(t => t.id === selected.value) ?? props.threads[0] ?? null,
)
const heading = ref<HTMLElement | null>(null)
const threadBox = ref<HTMLElement | null>(null)
// runs before the DOM changes, while focus is still where the user left it
watch(
  () => current.value?.id,
  async () => {
    if (!threadBox.value?.contains(document.activeElement)) return
    await nextTick()
    heading.value?.focus()
  },
  { flush: 'pre' },
)

function onDiscarded(id: string) {
  emit('discarded', id)
  if (selected.value === id) selected.value = null
}
function onPromoted(s: Session) {
  emit('promoted', s)
  if (selected.value === s.id) selected.value = null
}
</script>

<template>
  <div class="side-pane">
    <div class="side-pane__head">
      <h2 ref="heading" class="side-pane__heading" tabindex="-1">Side threads</h2>
      <span class="side-pane__hint">⌥↵ or /btw in the message box asks one</span>
    </div>
    <div v-if="phase === 'loading'" class="side-pane__state">
      <IuSkeleton shape="row" :rows="2" />
    </div>
    <div v-else-if="phase === 'error'" class="side-pane__state">
      <IuErrorState
        title="Couldn’t load side threads"
        :body="error ?? 'Something went wrong.'"
        :trace-id="`GET /api/sessions?parentId=${parentId}&aside=true`"
        @retry="emit('retry')"
      />
    </div>
    <div v-else-if="!threads.length" class="side-pane__state">
      <IuEmpty
        title="No side threads"
        body="Ask a side question from the message box (⌥↵ or /btw) without interrupting this session."
      />
    </div>
    <template v-else>
      <ul class="side-pane__list" aria-label="Side threads">
        <li v-for="t in threads" :key="t.id">
          <button
            type="button"
            class="side-pane__item"
            :aria-current="t.id === current?.id ? 'true' : undefined"
            @click="selected = t.id"
          >
            <span class="side-pane__item-title">{{ t.title }}</span>
            <IuBadge
              :intent="statusIntent[SESSION_DISPLAY[t.state].status]"
              :tempo="SESSION_DISPLAY[t.state].status"
              dot
              size="xs"
              >{{ SESSION_DISPLAY[t.state].label }}</IuBadge
            >
            <span class="side-pane__item-time">{{ relativeTime(t.createdAt) }}</span>
          </button>
        </li>
      </ul>
      <div ref="threadBox" class="side-pane__thread">
        <SideThread
          v-if="current"
          :key="current.id"
          :session-id="current.id"
          :parent-id="parentId"
          :parent-entry-ids="parentEntryIds"
          @promoted="onPromoted"
          @discarded="onDiscarded"
        />
      </div>
    </template>
  </div>
</template>

<style>
.side-pane {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.side-pane__head {
  flex: none;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px 6px;
}
.side-pane__heading {
  margin: 0;
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text-2);
}
.side-pane__heading:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.side-pane__hint {
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.side-pane__thread {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.side-pane__state {
  padding: 12px 14px;
}
.side-pane__list {
  flex: none;
  max-height: 30%;
  overflow-y: auto;
  margin: 0;
  padding: 0 8px 8px;
  list-style: none;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.side-pane__item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--iu-radius-md);
  background: transparent;
  color: var(--iu-text);
  font: inherit;
  font-size: var(--iu-font-size-12);
  text-align: left;
  cursor: pointer;
}
.side-pane__item:hover {
  background: var(--iu-surface);
}
.side-pane__item[aria-current='true'] {
  background: var(--iu-surface);
  box-shadow: inset 2px 0 0 var(--iu-accent);
}
.side-pane__item:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.side-pane__item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-pane__item-time {
  flex: none;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11);
}
</style>
