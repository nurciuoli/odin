<script setup lang="ts">
// Home: the composer first, then what's in progress as perches (one row per running or waiting session: a flock whose
// behaviour is the state, what it's doing, the state in words, and small Allow/Deny/Answer actions on the ones paused
// for you), then an "Earlier" list. Each row is derived on the client from the session's transcript timestamps and the
// live frames that arrive while Home is open.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { Session } from '@odin/shared/api'
import type { PermissionRequest } from '@odin/shared/harness'
import { applyHarnessEvent } from '@odin/shared/transcript'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { useSessions } from '@/app/sessions'
import { isUnread, markAllSeen } from '@/app/seen'
import { IuButton } from '@/components/Button'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { IuFlock } from '@/components/Spinner'
import { buildPerch, type LaneSource, type Perch } from '@/screens/shared/lanes'
import { plural, relativeTime } from './format'
import { useQuickAnswer } from './useQuickAnswer'
import { useResource, useServerEvents } from './useResource'
import NewSessionForm from './NewSessionForm.vue'

const api = useApi()
const route = useRoute()
const projects = useProjects()
const live = useSessions()
const form = ref<InstanceType<typeof NewSessionForm> | null>(null)
const sessions = useResource<Session[]>(() => api.listSessions({ archived: false }))
void sessions.load()

// Detail per active session (transcript + open prompts), kept current from live frames.
const sources = ref<Record<string, LaneSource>>({})
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)

async function loadDetail(id: string) {
  try {
    const detail = await api.getSession(id)
    sources.value = {
      ...sources.value,
      [id]: { detail, extraTimes: sources.value[id]?.extraTimes ?? [] },
    }
  } catch {
    // the row draws from the record alone
  }
}
watch(
  () => live.active.value.map(s => `${s.id}:${s.state}`).join(','),
  () => {
    for (const s of live.active.value) {
      const known = sources.value[s.id]
      if (!known || known.detail.state !== s.state) void loadDetail(s.id)
    }
  },
  { immediate: true },
)

function touch(src: LaneSource, at: number): number[] {
  const times = src.extraTimes ?? []
  // a stream of deltas counts once a second, so a long reply doesn't grow the list without bound
  return times.length && at - times[times.length - 1]! < 1000 ? times : [...times, at]
}

useServerEvents(
  e => {
    if (e.type !== 'session.event') return
    const src = sources.value[e.sessionId]
    if (!src) return
    const ev = e.event
    const d = src.detail
    let next: LaneSource = src
    if (
      ev.type === 'entry' ||
      ev.type === 'tool.result' ||
      ev.type === 'delta' ||
      ev.type === 'task'
    ) {
      const transcript = applyHarnessEvent(d.transcript, ev)
      const stamped = ev.type === 'entry' && ev.entry.at
      next = {
        detail: { ...d, transcript },
        extraTimes: stamped ? src.extraTimes : touch(src, Date.now()),
      }
    } else if (ev.type === 'permission.request') {
      if (d.pending.some(p => p.id === ev.request.id)) return
      next = { ...src, detail: { ...d, pending: [...d.pending, ev.request] } }
    } else if (ev.type === 'permission.resolved') {
      next = { ...src, detail: { ...d, pending: d.pending.filter(p => p.id !== ev.requestId) } }
    } else return
    sources.value = { ...sources.value, [e.sessionId]: next }
  },
  () => {
    void sessions.load()
    for (const s of live.active.value) void loadDetail(s.id)
  },
)
let refresh: ReturnType<typeof setTimeout> | undefined
watch(live.revision, () => {
  clearTimeout(refresh)
  refresh = setTimeout(() => void sessions.load(), 250)
})
onBeforeUnmount(() => {
  clearTimeout(refresh)
  clearInterval(clock)
})
watch(
  () => route.query.launch,
  launch => {
    if (launch) form.value?.focus()
  },
)

const empty = computed(() => !projects.loading.value && !projects.projects.value.length)
const active = live.active
/** The record from the live store wins over the fetched detail (state, title). */
function sourceOf(s: Session): LaneSource {
  const src = sources.value[s.id]
  return {
    detail: {
      ...(src?.detail ?? { pending: [], transcript: [] }),
      id: s.id,
      title: s.title,
      state: s.state,
      waitingFor: s.waitingFor,
      createdAt: s.createdAt,
    },
    extraTimes: src?.extraTimes,
    work: live.workOf(s.id),
  }
}
const perches = computed<Perch[]>(() => active.value.map(s => buildPerch(sourceOf(s), now.value)))
const promptOf = (id: string): PermissionRequest | null =>
  active.value.find(s => s.id === id)?.state === 'waiting'
    ? (sources.value[id]?.detail.pending[0] ?? null)
    : null
const waiting = computed(() => active.value.filter(s => s.state === 'waiting').length)
const shownCount = computed(() => active.value.length + unread.value.length)
const progressSummary = computed(() =>
  waiting.value
    ? `${plural(shownCount.value, 'session')}, ${waiting.value} paused for you`
    : unread.value.length
      ? `${plural(shownCount.value, 'session')}, ${unread.value.length} finished`
      : plural(shownCount.value, 'session'),
)

const { answering, answer: answerPrompt } = useQuickAnswer()
async function answer(lane: Perch, allow: boolean) {
  const p = promptOf(lane.id)
  if (!p || !(await answerPrompt(lane.id, p, allow))) return
  const src = sources.value[lane.id]
  if (src)
    sources.value = {
      ...sources.value,
      [lane.id]: {
        ...src,
        detail: { ...src.detail, pending: src.detail.pending.filter(x => x.id !== p.id) },
      },
    }
}

const MAX_UNREAD = 5
const showAllUnread = ref(false)
// ── finished, not opened yet ──
// A session that stopped and hasn't been opened since stays with the active ones (see `app/seen.ts`).
const stopped = computed(() =>
  (sessions.data.value ?? []).filter(
    s =>
      s.state !== 'running' &&
      s.state !== 'waiting' &&
      !s.aside &&
      !active.value.some(a => a.id === s.id), // idle with background work: listed as in progress
  ),
)
// the newest few; any more go to Earlier so the active list stays short
const allUnread = computed(() =>
  stopped.value
    .filter(s => isUnread(s, now.value))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
)
const unread = computed(() =>
  showAllUnread.value ? allUnread.value : allUnread.value.slice(0, MAX_UNREAD),
)
const finishedText = (s: Session) => (s.state === 'failed' ? 'Failed' : 'Finished')

// ── earlier ──
const recent = computed(() => stopped.value.filter(s => !allUnread.value.includes(s)).slice(0, 5))

const history = { name: 'history' }
const sessionFor = (id: string) => active.value.find(s => s.id === id)
const projectSummary = (s: Session) => {
  const names = s.projects?.length ? s.projects : [s.project]
  const first = projects.projects.value.find(p => p.name === names[0])?.title ?? names[0]
  return first + (names.length > 1 ? ' +' + (names.length - 1) : '')
}
const title = (s: Session) =>
  (s.projects ?? [s.project])
    .map(name => projects.projects.value.find(p => p.name === name)?.title ?? name)
    .join(', ')
</script>

<template>
  <div class="launchpad">
    <IuEmpty
      v-if="empty"
      title="Your next project starts here"
      body="Add a repository to start a conversation with Claude or Codex."
      ><IuButton as="router-link" to="/projects/new" variant="primary"
        >Add project</IuButton
      ></IuEmpty
    >
    <template v-else>
      <section class="launchpad__composer" aria-label="Start a conversation">
        <NewSessionForm
          ref="form"
          visual
          :project="typeof route.query.project === 'string' ? route.query.project : undefined"
          :autofocus="!!route.query.launch"
        />
      </section>

      <section class="launchpad__section" aria-labelledby="launchpad-progress">
        <div class="launchpad__heading">
          <h2 id="launchpad-progress">In progress</h2>
          <span v-if="shownCount" class="launchpad__aside">{{ progressSummary }}</span>
          <IuButton
            v-if="allUnread.length"
            variant="link"
            size="sm"
            :disabled="!allUnread.length"
            @click="markAllSeen(allUnread)"
            >Mark all read</IuButton
          >
          <IuButton
            v-if="allUnread.length > MAX_UNREAD"
            variant="link"
            size="sm"
            class="launchpad__heading-end"
            :aria-expanded="showAllUnread"
            @click="showAllUnread = !showAllUnread"
            >{{ showAllUnread ? 'Show fewer' : `Show all ${allUnread.length} unread` }}</IuButton
          >
        </div>
        <IuSkeleton v-if="live.loading.value" shape="row" :rows="2" />
        <IuErrorState
          v-else-if="live.error.value"
          title="Couldn't load ongoing sessions"
          :body="live.error.value"
          trace-id="launchpad.ongoing"
          @retry="live.reload()"
        />
        <div v-else-if="!shownCount" class="launchpad__roost">
          <IuFlock state="idle" size="lg" />
          <p class="launchpad__quiet">All quiet. Sessions you start gather here.</p>
        </div>
        <ul v-else class="launchpad__perches" aria-label="Sessions in progress">
          <li v-for="p in perches" :key="p.id" class="launchpad__perch" :data-state="p.state">
            <span class="launchpad__perch-glyph" role="img" :aria-label="p.description"
              ><IuFlock size="xl" tone="neutral" :state="p.flock" :agents="p.agents"
            /></span>
            <RouterLink :to="p.to" class="launchpad__perch-title" :title="p.title">{{
              p.title
            }}</RouterLink>
            <span class="launchpad__perch-time">{{
              relativeTime(sessionFor(p.id)?.updatedAt ?? '')
            }}</span>
            <span class="launchpad__perch-project">{{
              sessionFor(p.id) ? projectSummary(sessionFor(p.id)!) : ''
            }}</span>
            <div class="launchpad__perch-label">
              <Transition name="launchpad-update" mode="out-in">
                <span :key="p.activity" class="launchpad__perch-activity" :title="p.activity">{{
                  p.activity
                }}</span>
              </Transition>
              <span v-if="p.state !== 'running'" class="launchpad__perch-word">{{ p.word }}</span>
            </div>
            <div class="launchpad__perch-state">
              <span
                v-if="promptOf(p.id)?.kind === 'tool' || p.state === 'paused'"
                class="launchpad__perch-actions"
              >
                <template v-if="promptOf(p.id)?.kind === 'tool'">
                  <IuButton
                    size="sm"
                    variant="secondary"
                    :disabled="!!answering"
                    :aria-label="`Allow: ${p.activity} (${p.title})`"
                    @click="answer(p, true)"
                    >Allow</IuButton
                  >
                  <IuButton
                    size="sm"
                    variant="ghost"
                    :disabled="!!answering"
                    :aria-label="`Deny: ${p.activity} (${p.title})`"
                    @click="answer(p, false)"
                    >Deny</IuButton
                  >
                </template>
                <IuButton
                  v-else
                  as="router-link"
                  :to="p.to"
                  size="sm"
                  variant="secondary"
                  :aria-label="`Answer ${p.title}`"
                  >Answer</IuButton
                >
              </span>
            </div>
          </li>
          <li
            v-for="s in unread"
            :key="s.id"
            class="launchpad__perch launchpad__perch--finished"
            data-state="finished"
          >
            <span class="launchpad__perch-glyph"
              ><IuFlock size="xl" :state="s.state === 'failed' ? 'failed' : 'idle'"
            /></span>
            <RouterLink
              :to="{ name: 'session', params: { id: s.id } }"
              class="launchpad__perch-title"
              :title="s.title"
              >{{ s.title }}</RouterLink
            >
            <span class="launchpad__perch-time">{{ relativeTime(s.updatedAt) }}</span>
            <span class="launchpad__perch-project">{{ projectSummary(s) }}</span>
            <div class="launchpad__perch-label">
              <span class="launchpad__perch-activity">{{ finishedText(s) }}</span>
              <span class="launchpad__perch-word">Not opened yet</span>
            </div>
            <div class="launchpad__perch-state" />
          </li>
        </ul>
      </section>

      <section class="launchpad__section" aria-labelledby="launchpad-recent">
        <div class="launchpad__heading">
          <h2 id="launchpad-recent">Earlier</h2>
          <IuButton
            as="router-link"
            :to="history"
            variant="link"
            size="sm"
            class="launchpad__heading-end"
            >All sessions</IuButton
          >
        </div>
        <IuSkeleton v-if="sessions.phase.value === 'loading'" shape="row" :rows="2" />
        <IuErrorState
          v-else-if="sessions.phase.value === 'error'"
          title="Couldn't load sessions"
          :body="sessions.error.value?.message ?? 'Unknown error'"
          trace-id="launchpad.sessions"
          @retry="sessions.load()"
        />
        <p v-else-if="!recent.length" class="launchpad__quiet">
          Nothing earlier yet. Finished sessions are listed here.
        </p>
        <ul v-else class="launchpad__list">
          <li v-for="s in recent" :key="s.id">
            <RouterLink
              :to="{ name: 'session', params: { id: s.id } }"
              class="launchpad__session"
              :title="s.title"
              ><span class="launchpad__session-title">{{ s.title }}</span>
              <span class="launchpad__session-meta"
                >{{ title(s) }} · {{ relativeTime(s.updatedAt) }}</span
              >
            </RouterLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style>
.launchpad {
  width: 100%;
  max-width: 800px;
  box-sizing: border-box;
  padding: 48px 0 64px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 40px;
}
.launchpad__composer {
  max-width: 800px;
  margin: 0 auto;
  text-align: left;
  width: 100%;
}
.launchpad__section {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.launchpad__heading {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.launchpad__heading h2 {
  margin: 0;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-2);
}
.launchpad__heading-end {
  margin-left: auto;
}
.launchpad__aside,
.launchpad__quiet {
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-13);
}
.launchpad__quiet {
  line-height: var(--iu-leading-relaxed);
  margin: 0;
}
.launchpad__roost {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 14px 0 6px;
  text-align: center;
}
.launchpad__perches {
  list-style: none;
  padding: 0;
  margin: 0;
}
.launchpad__perch {
  display: grid;
  grid-template-columns: 88px minmax(0, 1.1fr) minmax(0, 1.5fr) auto;
  gap: 3px 16px;
  align-items: center;
  padding: 14px 0;
  border-top: 1px solid var(--iu-border-quiet);
}
.launchpad__perch-glyph {
  display: flex;
  justify-content: center;
  grid-row: 1 / 3;
}
.launchpad__perch-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.launchpad__perch-title,
.launchpad__perch-activity {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  line-height: var(--iu-leading-snug);
}
.launchpad__perch-title {
  min-width: 0;
  grid-column: 2;
  grid-row: 1;
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-medium);
  text-decoration: none;
  border-radius: var(--iu-radius-sm);
}
.launchpad__perch-title:hover {
  color: var(--iu-accent);
}
.launchpad__perch-title:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.launchpad__perch-activity {
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12-5);
}
.launchpad__perch-time {
  grid-column: 4;
  grid-row: 1;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12-5);
  white-space: nowrap;
}
.launchpad__perch-project {
  grid-column: 2;
  grid-row: 2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12-5);
}
.launchpad__perch-label {
  grid-column: 3 / 5;
  grid-row: 2;
  min-width: 0;
  text-align: right;
}
/* activity and state share one line so a row is always title + time over project + activity */
.launchpad__perch-label {
  flex-direction: row;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}
.launchpad__perch-label > .launchpad__perch-activity {
  min-width: 0;
}
.launchpad-update-enter-active,
.launchpad-update-leave-active {
  transition: opacity var(--iu-dur) var(--iu-ease);
}
.launchpad-update-enter-from,
.launchpad-update-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .launchpad-update-enter-active,
  .launchpad-update-leave-active {
    transition: none;
  }
}
.launchpad__perch-state:empty {
  display: none;
}
.launchpad__perch-state {
  grid-column: 3;
  grid-row: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  min-width: 0;
}
.launchpad__perch-word {
  color: var(--iu-text-2);
  font-size: var(--iu-font-size-12-5);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.launchpad__perch[data-state='paused'] .launchpad__perch-word {
  color: var(--iu-warning);
}
.launchpad__perch-actions {
  display: inline-flex;
  gap: 4px;
}
.launchpad__list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.launchpad__list li {
  border-top: 1px solid var(--iu-border-quiet);
}
.launchpad__session {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 0;
  color: var(--iu-text);
  text-decoration: none;
  border-radius: var(--iu-radius-sm);
}
.launchpad__session:hover .launchpad__session-title {
  color: var(--iu-accent);
}
.launchpad__session:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 3px;
}
.launchpad__session-title {
  flex: 1;
  text-align: left;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--iu-font-size-13-5);
}
.launchpad__session-meta {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 30%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
@media (max-width: 720px) {
  .launchpad__perch {
    grid-template-columns: 76px minmax(0, 1fr) auto;
    gap: 6px 12px;
  }
  .launchpad__perch-title {
    grid-column: 2;
  }
  .launchpad__perch-time {
    grid-column: 3;
  }
  .launchpad__perch-project {
    grid-column: 2 / 4;
  }
  .launchpad__perch-label {
    grid-column: 2 / 4;
    justify-content: flex-start;
  }
  .launchpad__perch-state {
    grid-column: 2 / 4;
    grid-row: 3;
    justify-content: flex-start;
    flex-wrap: wrap;
  }
}
@media (max-width: 760px) {
  .launchpad {
    padding: 24px 0;
  }
  .launchpad__session {
    flex-direction: column;
    gap: 4px;
  }
  .launchpad__session-meta {
    max-width: 100%;
  }
}
</style>
