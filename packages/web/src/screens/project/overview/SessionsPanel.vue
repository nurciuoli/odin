<script setup lang="ts">
// The latest sessions as one compact list, the live flock on running and waiting rows. A waiting tool prompt can be
// allowed once or denied in place; questions and plans open the session. Updates never move focus.
import { computed, ref, watch } from 'vue'
import type { PermissionRequest } from '@odin/shared/harness'
import type { Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuFlock } from '@/components/Spinner'
import { IuEmpty, IuErrorState } from '@/components/States'
import { IuStatusDot } from '@/components/StatusDot'
import type { LoadError } from '@/screens/shared/useResource'
import { SESSION_DISPLAY, formatCost, relativeTime } from '@/screens/shared/format'
import { useQuickAnswer } from '@/screens/shared/useQuickAnswer'
import OverviewPanel from './OverviewPanel.vue'
import { formatCount, formatDuration } from './overview'

const props = defineProps<{
  project: string
  sessions: Session[] | null
  git: boolean
  loading: boolean
  error: LoadError | null
}>()
const emit = defineEmits<{ retry: [] }>()
const api = useApi()

const LIMIT = 6
const latest = computed(() =>
  (props.sessions ?? [])
    .filter(s => !s.archived && !s.aside)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, LIMIT),
)

// The open prompt of each waiting row, read from its detail.
const prompts = ref<Record<string, PermissionRequest | null>>({})
watch(
  () =>
    latest.value
      .filter(s => s.state === 'waiting')
      .map(s => `${s.id}@${s.updatedAt}`)
      .join(),
  async () => {
    const waiting = latest.value.filter(s => s.state === 'waiting')
    const next: Record<string, PermissionRequest | null> = {}
    await Promise.all(
      waiting.map(async s => {
        try {
          next[s.id] = (await api.getSession(s.id)).pending[0] ?? null
        } catch {
          next[s.id] = null
        }
      }),
    )
    prompts.value = next
  },
  { immediate: true },
)

const { answering, answer } = useQuickAnswer()
async function quick(s: Session, allow: boolean) {
  const p = prompts.value[s.id]
  if (!p || !(await answer(s.id, p, allow))) return
  prompts.value = { ...prompts.value, [s.id]: null }
}

interface Row {
  id: string
  title: string
  state: string
  model: string
  active: string
  cost: string
  session: Session
}
const rows = computed<Row[]>(() =>
  latest.value.map(s => ({
    id: s.id,
    title: s.title,
    state: s.state,
    model: s.model ? s.model.replace(/^claude-/, '') : '—',
    active: s.metrics.activeMs ? formatDuration(s.metrics.activeMs) : '—',
    cost: formatCost(s.metrics.costUsd) || '—',
    session: s,
  })),
)
</script>

<template>
  <OverviewPanel id="overview-sessions" title="Sessions">
    <template #actions>
      <RouterLink
        :to="{ name: 'project-sessions', params: { name: project } }"
        class="ov-sessions__more"
        >All sessions</RouterLink
      >
    </template>
    <IuErrorState
      v-if="error && !sessions"
      title="Couldn't load the sessions"
      :body="error.message"
      :trace-id="`project.sessions.${error.status}`"
      @retry="emit('retry')"
    />
    <IuEmpty
      v-else-if="!loading && !latest.length"
      title="No sessions yet"
      body="Sessions you start in this project show up here."
    />
    <ul v-else class="ov-sessions__list" aria-live="polite">
      <li v-for="row in rows" :key="row.id" class="ov-sessions__row">
        <div class="ov-sessions__main">
          <RouterLink
            :to="{ name: 'session', params: { id: row.id } }"
            class="ov-sessions__link"
            :title="row.title"
            >{{ row.title }}</RouterLink
          >
          <span class="ov-sessions__state">
            <template v-if="row.session.state === 'running' || row.session.state === 'waiting'">
              <IuFlock :state="SESSION_DISPLAY[row.session.state].flock" tone="neutral" size="sm" />
              <span>{{ SESSION_DISPLAY[row.session.state].label }}</span>
            </template>
            <template v-else>
              <IuStatusDot :status="SESSION_DISPLAY[row.session.state].status" decorative />
              <span
                >{{ SESSION_DISPLAY[row.session.state].label }}
                <time :datetime="row.session.updatedAt">{{
                  relativeTime(row.session.updatedAt)
                }}</time></span
              >
            </template>
          </span>
        </div>
        <div class="ov-sessions__side">
          <code class="ov-sessions__mono">{{ row.model }}</code>
          <span class="ov-sessions__num">{{ row.active }}</span>
          <span class="ov-sessions__num">{{ row.cost }}</span>
          <span v-if="git" class="ov-sessions__lines">
            <template v-if="row.session.metrics.diff"
              >+{{ formatCount(row.session.metrics.diff.added) }} −{{
                formatCount(row.session.metrics.diff.removed)
              }}</template
            >
            <template v-else>—</template>
          </span>
        </div>
        <span v-if="row.session.state === 'waiting'" class="ov-sessions__actions">
          <template v-if="prompts[row.id]?.kind === 'tool'">
            <IuButton
              size="sm"
              variant="secondary"
              :disabled="!!answering"
              :aria-label="`Allow once: ${row.title}`"
              @click="quick(row.session, true)"
              >Allow once</IuButton
            >
            <IuButton
              size="sm"
              variant="ghost"
              :disabled="!!answering"
              :aria-label="`Deny: ${row.title}`"
              @click="quick(row.session, false)"
              >Deny</IuButton
            >
          </template>
          <IuButton
            v-else-if="prompts[row.id]"
            as="router-link"
            :to="{ name: 'session', params: { id: row.id } }"
            size="sm"
            variant="secondary"
            :aria-label="`Answer ${row.title}`"
            >Answer</IuButton
          >
        </span>
      </li>
    </ul>
  </OverviewPanel>
</template>

<style>
.ov-sessions__more {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  font-weight: var(--iu-font-weight-medium);
}
.ov-sessions__more:focus-visible,
.ov-sessions__link:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.ov-sessions__list {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.ov-sessions__row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 0;
  min-width: 0;
  border-top: 1px solid var(--iu-border-quiet);
}
.ov-sessions__row:first-child {
  border-top: 0;
  padding-top: 0;
}
.ov-sessions__main,
.ov-sessions__side {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.ov-sessions__link {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
}
.ov-sessions__state {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.ov-sessions__side {
  justify-content: flex-start;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.ov-sessions__side > :nth-child(2) {
  margin-inline-start: auto;
}
.ov-sessions__num,
.ov-sessions__lines {
  font-family: var(--iu-font-mono);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ov-sessions__actions {
  display: flex;
  gap: 4px;
}
.ov-sessions__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  white-space: nowrap;
}
</style>
