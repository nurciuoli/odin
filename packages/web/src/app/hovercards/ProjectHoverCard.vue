<script setup lang="ts">
// The project overview shown on hover: health, what's running or needs you, and the latest sessions.
import { computed, onMounted, shallowRef } from 'vue'
import type { ProjectDetail, ProjectSummary, Session } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { IuIcon } from '@/components/Icon'
import { IuSparkline } from '@/components/Sparkline'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import { useApi } from '@/api'
import { useSessions } from '@/app/sessions'
import { useProjects } from '@/app/projects'
import {
  SESSION_DISPLAY,
  SYNC_DISPLAY,
  plural,
  projectStatus,
  relativeTime,
} from '@/screens/shared/format'
import { hoverVariant } from './variant'
import './hovercards.css'

const props = defineProps<{ name: string }>()
const api = useApi()
const store = useProjects()
const sessions = useSessions()
const detail = shallowRef<ProjectDetail | null>(null)
const recent = shallowRef<Session[] | null>(null)
onMounted(() => {
  api
    .getProject(props.name)
    .then(d => (detail.value = d))
    .catch(() => {})
  api
    .listSessions({ project: props.name, limit: 3 })
    .then(l => (recent.value = l))
    .catch(() => (recent.value = []))
})

const project = computed<ProjectSummary | undefined>(() =>
  store.projects.value.find(p => p.name === props.name),
)
// Live counts, like the sidebar's, so the card never disagrees with the row it hangs off.
const counts = computed(() => sessions.countsFor(props.name))
const status = computed(() => {
  const p = project.value
  return p ? projectStatus({ ...p, sessions: { ...p.sessions, ...counts.value } }) : 'idle'
})
const lastActive = computed(() => detail.value?.lastSessionAt ?? project.value?.updatedAt ?? null)
const git = computed(() => detail.value?.git ?? null)
</script>

<template>
  <div v-if="project" class="hc" :class="`hc--${hoverVariant}`">
    <header class="hc__head">
      <IuStatusDot :status="status" :size="9" decorative />
      <span class="hc__title">{{ project.title }}</span>
      <IuBadge v-if="project.missing" intent="danger" size="xs">Folder missing</IuBadge>
    </header>
    <p v-if="project.description" class="hc__state hc__clamp">{{ project.description }}</p>

    <dl class="hc__props">
      <div v-if="project.repo">
        <dt><IuIcon name="link" :size="14" /><span class="hc__sr">Repository</span></dt>
        <dd class="hc__mono">{{ project.repo }}</dd>
      </div>
      <div v-if="git?.branch">
        <dt><IuIcon name="gitBranch" :size="14" /><span class="hc__sr">Branch</span></dt>
        <dd class="hc__mono">
          {{ git.branch
          }}<span v-if="git.ahead || git.behind || git.dirty" class="hc__dim">
            ·
            {{
              [
                git.ahead && `${git.ahead} ahead`,
                git.behind && `${git.behind} behind`,
                git.dirty && 'uncommitted',
              ]
                .filter(Boolean)
                .join(', ')
            }}</span
          >
        </dd>
      </div>
    </dl>

    <div class="hc__counts">
      <span class="hc__count" :class="{ 'is-attention': counts.waiting > 0 }">
        <strong class="hc__mono">{{ counts.waiting }}</strong> need{{
          counts.waiting === 1 ? 's' : ''
        }}
        you
      </span>
      <span class="hc__count">
        <strong class="hc__mono">{{ counts.running }}</strong> running
      </span>
      <span class="hc__count hc__dim">
        <strong class="hc__mono">{{ project.sessions.total }}</strong> total
      </span>
    </div>

    <div v-if="hoverVariant === 'b'" class="hc__spark">
      <IuSparkline
        :values="project.activity"
        label="Sessions per day, last 14 days"
        :height="28"
        area
      />
      <span class="hc__dim">14 days</span>
    </div>

    <section aria-label="Recent sessions">
      <h3 class="hc__eyebrow">Recent sessions</h3>
      <ul v-if="recent?.length" class="hc__list">
        <li v-for="s in recent" :key="s.id">
          <IuStatusDot :status="SESSION_DISPLAY[s.state].status" :size="7" decorative />
          <span class="hc__li-title">{{ s.title }}</span>
          <span class="hc__dim">{{ relativeTime(s.updatedAt) }}</span>
        </li>
      </ul>
      <p v-else-if="recent" class="hc__dim">No sessions yet</p>
      <p v-else class="hc__dim">Loading…</p>
    </section>

    <footer class="hc__foot">
      <span class="hc__dim">
        {{ lastActive ? `Last active ${relativeTime(lastActive)}` : 'No activity yet' }}
      </span>
      <span v-if="project.sync.state !== 'off'" class="hc__dim"
        >· Sync: {{ SYNC_DISPLAY[project.sync.state].label.toLowerCase() }}</span
      >
      <span class="hc__dim">· {{ plural(project.sessions.total, 'session') }}</span>
    </footer>
  </div>
</template>
