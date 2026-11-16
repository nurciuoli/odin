<script setup lang="ts">
// A project's analytics and key facts. One range control drives every number and chart; activity is fetched for
// twice the range so each total compares with the period before it. Git panels show only for git folders, the
// pull request panel only when GitHub sync is on; a hidden panel's row partner takes the full width. Every panel
// loads, fails and empties on its own, and live updates never move focus.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type {
  Artifact,
  MetricsRow,
  ProjectActivity,
  ProjectBranch,
  Session,
} from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { useSessions } from '@/app/sessions'
import { hasDesktop, openPath } from '@/app/desktop'
import { IuBadge } from '@/components/Badge'
import { IuSegmented } from '@/components/Segmented'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { relativeTime } from '@/screens/shared/format'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import { useProject } from '../useProject'
import ActivityChart from './ActivityChart.vue'
import BranchesPanel from './BranchesPanel.vue'
import CodeChangedPanel from './CodeChangedPanel.vue'
import ModelsPanel from './ModelsPanel.vue'
import OverviewPanel from './OverviewPanel.vue'
import ProjectPanel from './ProjectPanel.vue'
import PullsPanel from './PullsPanel.vue'
import SessionsPanel from './SessionsPanel.vue'
import TotalsRow from './TotalsRow.vue'
import TypicalPanel from './TypicalPanel.vue'
import {
  RANGES,
  loadRange,
  rangeBounds,
  rangeDays,
  saveRange,
  spanLabel,
  splitPeriods,
  totals,
  type RangeId,
} from './overview'
import { relatedProjects } from './related'
import { settle, type Settled } from './settled'

const api = useApi()
const live = useSessions()
const store = useProjects()
const { detail } = useProject()
const name = computed(() => detail.value.name)

const git = computed(() => detail.value.git.branch !== null || detail.value.git.headSha !== null)
const github = computed(() => git.value && detail.value.settings.githubEnabled === true)
const hasSessions = computed(() => detail.value.firstSessionAt !== null)

// ── range ──
const range = ref<RangeId>(loadRange())
const rangeModel = computed({
  get: () => range.value as string,
  set: (v: string) => {
    range.value = v as RangeId
    saveRange(range.value)
  },
})
const days = computed(() => rangeDays(range.value))

interface RangeData {
  days: number
  since: string
  activity: Settled<ProjectActivity>
  models: Settled<MetricsRow[]>
  harnesses: Settled<MetricsRow[]>
  typical: Settled<MetricsRow[]>
}
// One fetch per range so every number, chart and comparison changes in the same step; each part fails on its own.
const rangeData = useResource<RangeData>(async () => {
  const n = days.value
  const { since, until } = rangeBounds(n)
  const q = { project: name.value, since, until }
  const [activity, models, harnesses, typical] = await Promise.all([
    settle(api.getProjectActivity(name.value, 2 * n)),
    settle(api.getMetrics({ ...q, groupBy: ['model'] })),
    settle(api.getMetrics({ ...q, groupBy: ['harness'] })),
    settle(api.getMetrics({ ...q, groupBy: [] })),
  ])
  return { days: n, since, activity, models, harnesses, typical }
})
const sessions = useResource<Session[]>(() => api.listSessions({ project: name.value }))
const branches = useResource<ProjectBranch[]>(() => api.listProjectBranches(name.value))
const artifacts = useResource<Artifact[]>(() => api.listProjectArtifacts(name.value, 4))

function loadBranches() {
  if (git.value) void branches.load()
}
watch(
  name,
  () => {
    for (const r of [rangeData, sessions, branches, artifacts]) r.reset()
    void rangeData.load()
    void sessions.load()
    void artifacts.load()
    loadBranches()
  },
  { immediate: true },
)
watch(range, () => void rangeData.load())

let timer: ReturnType<typeof setTimeout> | undefined
watch(live.revision, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void sessions.load(), 250)
})
onBeforeUnmount(() => clearTimeout(timer))
useServerEvents(
  (e: ServerEvent) => {
    if (e.type === 'artifact.updated') void artifacts.load()
  },
  () => {
    void rangeData.load()
    void sessions.load()
    void artifacts.load()
    loadBranches()
  },
)

// ── derived ──
const activityError = computed(() => {
  const a = rangeData.data.value?.activity
  return a && !a.ok ? a.error : (rangeData.error.value ?? null)
})
const series = computed(() => {
  const a = rangeData.data.value?.activity
  return a?.ok ? a.value.days : null
})
const periods = computed(() =>
  series.value ? splitPeriods(series.value, rangeData.data.value!.days) : null,
)
const current = computed(() => (periods.value ? totals(periods.value.current) : null))
const previous = computed(() =>
  periods.value?.previous.length ? totals(periods.value.previous) : null,
)
const span = computed(() => {
  const c = periods.value?.current
  return c?.length ? spanLabel(c[0]!.date, c[c.length - 1]!.date) : ''
})
const rangeLoading = computed(() => rangeData.phase.value === 'loading')
const since = computed(() => rangeData.data.value?.since ?? rangeBounds(days.value).since)

const related = computed(() =>
  relatedProjects(
    name.value,
    (sessions.data.value ?? []).filter(s => !s.aside),
  ).slice(0, 5),
)
const titleOf = (n: string) => store.projects.value.find(p => p.name === n)?.title ?? n

// ── documents (unchanged from the earlier Overview) ──
const desktop = hasDesktop()
const excerpts = computed(() => detail.value.context?.excerpts ?? [])
const showBrief = computed(
  () =>
    excerpts.value.length > 0 ||
    (detail.value.context?.customized === true && detail.value.context.sources.status.length === 0),
)
const planningDocs = computed(() => detail.value.context?.planning ?? [])
const showPlanning = computed(
  () =>
    planningDocs.value.length > 0 ||
    (detail.value.context?.customized === true && detail.value.context.sources.planning.length > 0),
)
async function openDoc(path: string) {
  if (!hasDesktop()) return
  await openPath(`${detail.value.path.replace(/[\\/]$/, '')}/${path}`, 'editor')
}

// ── grid spans: a hidden panel's partner widens to fill its row ──
const pair = (a: boolean, b: boolean, wa: number, wb: number) => ({
  a: b ? wa : 12,
  b: a ? wb : 12,
})
const row4 = computed(() => pair(true, hasSessions.value, 7, 5))
const row5 = computed(() => pair(hasSessions.value, git.value, 4, 8))
const row6 = computed(() => pair(git.value, github.value, 7, 5))
const row7 = computed(() => {
  if (showBrief.value && showPlanning.value) return { brief: 5, planning: 3, outputs: 4 }
  if (showBrief.value) return { brief: 7, planning: 0, outputs: 5 }
  if (showPlanning.value) return { brief: 0, planning: 5, outputs: 7 }
  return { brief: 0, planning: 0, outputs: 12 }
})
const span$ = (n: number) => ({ '--ov-span': String(n) })
</script>

<template>
  <div class="overview">
    <div class="overview__bar">
      <p class="overview__span" aria-live="polite">{{ span }}</p>
      <IuSegmented
        v-model="rangeModel"
        :options="RANGES.map(r => ({ value: r.value, label: r.label }))"
        label="Time range"
      />
    </div>

    <TotalsRow
      :current="current"
      :previous="previous"
      :git="git"
      :loading="rangeLoading"
      :error="series ? null : activityError"
      @retry="rangeData.load()"
    />

    <div class="overview__grid">
      <ActivityChart
        class="overview__cell"
        :style="span$(8)"
        :days="periods?.current ?? null"
        :git="git"
        :loading="rangeLoading"
        :error="activityError"
        @retry="rangeData.load()"
      />
      <ProjectPanel
        class="overview__cell"
        :style="span$(4)"
        :detail="detail"
        :git="git"
        :related="related"
        :title-of="titleOf"
      />

      <SessionsPanel
        class="overview__cell"
        :style="span$(row4.a)"
        :project="name"
        :sessions="sessions.data.value"
        :git="git"
        :loading="sessions.phase.value === 'loading'"
        :error="sessions.error.value"
        @retry="sessions.load()"
      />
      <ModelsPanel
        v-if="hasSessions"
        class="overview__cell"
        :style="span$(row4.b)"
        :project="name"
        :models="rangeData.data.value?.models ?? null"
        :harnesses="rangeData.data.value?.harnesses ?? null"
        :loading="rangeLoading"
        @retry="rangeData.load()"
      />

      <TypicalPanel
        v-if="hasSessions"
        class="overview__cell"
        :style="span$(row5.a)"
        :typical="rangeData.data.value?.typical ?? null"
        :loading="rangeLoading"
        @retry="rangeData.load()"
      />
      <CodeChangedPanel
        v-if="git"
        class="overview__cell"
        :style="span$(row5.b)"
        :days="periods?.current ?? null"
        :loading="rangeLoading"
        :error="activityError"
        @retry="rangeData.load()"
      />

      <BranchesPanel
        v-if="git"
        class="overview__cell"
        :style="span$(row6.a)"
        :branches="branches.data.value"
        :default-branch="detail.settings.defaultBranch"
        :loading="branches.phase.value === 'loading'"
        :error="branches.error.value"
        @retry="branches.load()"
      />
      <PullsPanel
        v-if="github"
        class="overview__cell"
        :style="span$(row6.b)"
        :project="name"
        :sessions="sessions.data.value"
        :since="since"
        :loading="sessions.phase.value === 'loading'"
        :error="sessions.error.value"
        @retry="sessions.load()"
      />

      <!-- Deterministic excerpts. Hidden until a status document is selected or discovery finds one. -->
      <OverviewPanel
        v-if="showBrief"
        id="overview-brief"
        title="Where things stand"
        class="overview__cell"
        :style="span$(row7.brief)"
      >
        <IuEmpty
          v-if="!excerpts.length"
          title="No status source selected"
          body="Choose a status document in project settings."
        />
        <ul v-else class="overview__list">
          <li v-for="excerpt in excerpts" :key="excerpt.path" class="overview__excerpt">
            <p v-if="excerpt.heading" class="overview__strong">{{ excerpt.heading }}</p>
            <p class="overview__quote">{{ excerpt.text }}</p>
            <p class="overview__muted">
              <button
                v-if="desktop"
                type="button"
                class="overview__link overview__mono"
                @click="openDoc(excerpt.path)"
              >
                {{ excerpt.path }}
              </button>
              <span v-else class="overview__mono">{{ excerpt.path }}</span>
            </p>
          </li>
        </ul>
      </OverviewPanel>

      <OverviewPanel
        v-if="showPlanning"
        id="overview-planning"
        title="Planning"
        class="overview__cell"
        :style="span$(row7.planning)"
      >
        <IuEmpty
          v-if="!planningDocs.length"
          title="No planning files"
          body="Markdown under the selected planning folders shows up here."
        />
        <ul v-else class="overview__list">
          <li v-for="doc in planningDocs" :key="doc.path" class="overview__row">
            <button v-if="desktop" type="button" class="overview__link" @click="openDoc(doc.path)">
              {{ doc.title }}
            </button>
            <span v-else class="overview__strong">{{ doc.title }}</span>
            <span v-if="doc.status" class="overview__muted">{{ doc.status }}</span>
            <span class="overview__muted overview__mono">{{ doc.path }}</span>
          </li>
        </ul>
      </OverviewPanel>

      <OverviewPanel
        id="overview-outputs"
        title="Latest outputs"
        class="overview__cell"
        :style="span$(row7.outputs)"
      >
        <template #actions>
          <RouterLink
            :to="{ name: 'project-outputs', params: { name } }"
            class="overview__link overview__more"
            >All outputs</RouterLink
          >
        </template>
        <IuSkeleton v-if="artifacts.phase.value === 'loading'" shape="row" :rows="2" />
        <IuErrorState
          v-else-if="artifacts.phase.value === 'error'"
          title="Couldn't load the outputs"
          :body="artifacts.error.value?.message ?? 'Unknown error'"
          :trace-id="`project.artifacts.${artifacts.error.value?.status ?? 0}`"
          @retry="artifacts.load()"
        />
        <IuEmpty
          v-else-if="!artifacts.data.value?.length"
          title="No outputs yet"
          body="Artifacts agents post in this project show up here."
        />
        <ul v-else class="overview__list">
          <li v-for="a in artifacts.data.value" :key="a.id" class="overview__row">
            <RouterLink
              :to="{
                name: 'session',
                params: { id: a.sessionId },
                query: { artifact: String(a.id) },
              }"
              class="overview__link"
              >{{ a.title }}</RouterLink
            >
            <IuBadge variant="tag" size="xs">v{{ a.latestVersion }}</IuBadge>
            <time class="overview__muted" :datetime="a.updatedAt">{{
              relativeTime(a.updatedAt)
            }}</time>
          </li>
        </ul>
      </OverviewPanel>
    </div>
  </div>
</template>

<style>
.overview {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 1280px;
  min-width: 0;
  padding-top: 8px;
}
.overview__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.overview__span {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.overview__grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 12px;
}
.overview__cell {
  grid-column: span var(--ov-span, 12);
}
@media (max-width: 980px) {
  .overview__cell {
    grid-column: span 12;
  }
}
.overview__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.overview__row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 10px;
  min-width: 0;
}
.overview__excerpt {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.overview__strong {
  margin: 0;
  font-weight: var(--iu-font-weight-medium);
}
.overview__quote {
  margin: 0;
  padding-left: 12px;
  border-left: 2px solid var(--iu-border);
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
  overflow-wrap: anywhere;
}
.overview__link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--iu-text);
  font: inherit;
  font-weight: var(--iu-font-weight-medium);
  text-align: start;
  cursor: pointer;
  overflow-wrap: anywhere;
}
.overview__link:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.overview__more {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.overview__muted {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.overview__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  overflow-wrap: anywhere;
}
</style>
