<script setup lang="ts">
// The latest sessions as one table, the live flock on running and waiting rows. A waiting tool prompt can be
// allowed once or denied in place; questions and plans open the session. Updates never move focus.
import { computed, ref, watch } from 'vue'
import type { PermissionRequest } from '@odin/shared/harness'
import type { Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuFlock } from '@/components/Spinner'
import { IuEmpty, IuErrorState } from '@/components/States'
import { IuStatusDot } from '@/components/StatusDot'
import { IuTable, type Column } from '@/components/Table'
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

interface Row extends Record<string, unknown> {
  id: string
  title: string
  state: string
  model: string
  active: string
  cost: string
  lines: string
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
    lines: '',
    session: s,
  })),
)
const columns = computed<Column<Row>[]>(() => [
  { key: 'title', header: 'Session', width: '40%' },
  { key: 'state', header: 'State' },
  { key: 'model', header: 'Model' },
  { key: 'active', header: 'Active', align: 'end', numeric: true },
  { key: 'cost', header: 'Cost', align: 'end', numeric: true },
  ...(props.git ? [{ key: 'lines', header: 'Lines', align: 'end', numeric: true } as const] : []),
])

const WORD: Record<Session['state'], string> = {
  running: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  ended: 'Finished',
  failed: 'Failed',
}
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
    <IuTable
      v-else
      :columns="columns"
      :rows="rows"
      :row-key="r => r.id"
      :loading="loading && !sessions"
      :sticky-header="false"
      density="compact"
      min-width="560px"
      aria-live="polite"
    >
      <template #cell:title="{ row }">
        <RouterLink :to="{ name: 'session', params: { id: row.id } }" class="ov-sessions__link">{{
          row.title
        }}</RouterLink>
      </template>
      <template #cell:state="{ row }">
        <span class="ov-sessions__state">
          <template v-if="row.session.state === 'running' || row.session.state === 'waiting'">
            <IuFlock
              :state="row.session.state === 'waiting' ? 'waiting' : 'working'"
              tone="neutral"
              size="sm"
            />
            <span>{{ WORD[row.session.state] }}</span>
          </template>
          <template v-else>
            <IuStatusDot :status="SESSION_DISPLAY[row.session.state].status" decorative />
            <span
              >{{ WORD[row.session.state] }}
              <time :datetime="row.session.updatedAt">{{
                relativeTime(row.session.updatedAt)
              }}</time></span
            >
          </template>
        </span>
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
      </template>
      <template #cell:model="{ row }">
        <code class="ov-sessions__mono">{{ row.model }}</code>
      </template>
      <template #cell:lines="{ row }">
        <span v-if="row.session.metrics.diff" class="ov-sessions__lines"
          ><span>+{{ formatCount(row.session.metrics.diff.added) }}</span>
          <span>−{{ formatCount(row.session.metrics.diff.removed) }}</span></span
        >
        <span v-else>—</span>
      </template>
    </IuTable>
  </OverviewPanel>
</template>

<style>
.ov-sessions__more,
.ov-sessions__link {
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
}
.ov-sessions__more {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.ov-sessions__more:focus-visible,
.ov-sessions__link:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.ov-sessions__state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.ov-sessions__actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}
.ov-sessions__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  white-space: nowrap;
}
.ov-sessions__lines {
  display: inline-flex;
  gap: 6px;
  white-space: nowrap;
}
</style>
