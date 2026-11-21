<script setup lang="ts">
// The session overview shown on hover: what it is, how it's going, and where it left off.
import { computed, onMounted, shallowRef } from 'vue'
import type { Session, SessionDetail } from '@odin/shared/api'
import { lastRunAt } from '@odin/shared/session'
import { IuBadge } from '@/components/Badge'
import { IuIcon } from '@/components/Icon'
import { IuFlock } from '@/components/Spinner'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import StatusWord from '@/screens/shared/StatusWord.vue'
import { useApi } from '@/api'
import { SESSION_DISPLAY, formatCost, harnessLabel, relativeTime } from '@/screens/shared/format'
import { placeFolder, placeLabel } from '@/screens/shared/place'
import './hovercards.css'

const props = defineProps<{ session: Session }>()
const api = useApi()
const detail = shallowRef<SessionDetail | null>(null)
const failed = shallowRef(false)
onMounted(() => {
  api
    .getSession(props.session.id)
    .then(d => (detail.value = d))
    .catch(() => (failed.value = true))
})

const display = computed(() => SESSION_DISPLAY[props.session.state])
const metrics = computed(() => props.session.metrics)
const project = computed(() => props.session.project)
const place = computed(() => placeLabel(props.session.branch, placeFolder(props.session)))
// what a session that needs you is waiting for
const needs = computed(() =>
  props.session.state !== 'waiting'
    ? ''
    : props.session.waitingFor === 'question'
      ? 'Has a question for you'
      : 'Asking for your permission',
)
// Last thing the agent said; falls back to the last thing you asked.
const snippet = computed(() => {
  const t = detail.value?.transcript ?? []
  const pick = (kind: 'assistant' | 'user') =>
    [...t].reverse().find(e => e.kind === kind && 'text' in e && e.text.trim())
  const e = pick('assistant') ?? pick('user')
  const text = e && 'text' in e ? e.text.replace(/\s+/g, ' ').trim() : ''
  return { text, by: e?.kind === 'user' ? 'You' : harnessLabel(props.session.harness) }
})
const ctx = computed(() => {
  const used = metrics.value.contextTokens
  const max = metrics.value.contextWindow ?? null
  return used && max ? { used, max } : null
})
const cost = computed(() => formatCost(metrics.value.costUsd))
</script>

<template>
  <div class="hc">
    <header class="hc__head">
      <IuFlock v-if="display.flock" :state="display.flock" tone="neutral" />
      <IuStatusDot v-else :status="display.status" :size="9" decorative />
      <span class="hc__title">{{ session.title }}</span>
    </header>
    <p class="hc__state">
      <StatusWord
        :word="display.label"
        :since="lastRunAt(session) ? `last run ${relativeTime(lastRunAt(session) ?? '')}` : ''"
      />
    </p>
    <p v-if="needs" class="hc__need">{{ needs }}</p>

    <dl class="hc__props">
      <div>
        <dt>Last updated</dt>
        <dd>
          <time :datetime="session.updatedAt" :title="session.updatedAt">{{
            relativeTime(session.updatedAt)
          }}</time>
        </dd>
      </div>
      <div>
        <dt><IuIcon name="folder" :size="14" /><span class="hc__sr">Project</span></dt>
        <dd>
          {{ project
          }}<template v-if="session.projects.length > 1">
            <span class="hc__dim"> +{{ session.projects.length - 1 }}</span></template
          >
        </dd>
      </div>
      <div v-if="session.branch">
        <dt><IuIcon name="gitBranch" :size="14" /><span class="hc__sr">Branch</span></dt>
        <dd class="hc__mono">{{ place }}</dd>
      </div>
      <div>
        <dt><IuIcon name="sparkle" :size="14" /><span class="hc__sr">Harness and model</span></dt>
        <dd>
          {{ harnessLabel(session.harness)
          }}<span v-if="session.model" class="hc__dim hc__mono"> · {{ session.model }}</span>
        </dd>
      </div>
    </dl>

    <blockquote v-if="snippet.text" class="hc__snippet">
      <span class="hc__by">{{ snippet.by }}</span>
      <span class="hc__clamp">{{ snippet.text }}</span>
    </blockquote>
    <p v-else-if="!detail && !failed" class="hc__snippet hc__dim">Loading last message…</p>

    <footer class="hc__foot">
      <span v-if="cost" class="hc__mono">{{ cost }}</span>
      <span v-if="ctx" class="hc__mono">{{ Math.round((ctx.used / ctx.max) * 100) }}% context</span>
      <span v-if="session.pull" class="hc__mono">PR #{{ session.pull.number }}</span>
      <IuBadge v-for="t in session.tags.slice(0, 2)" :key="t" variant="tag" size="xs">{{
        t
      }}</IuBadge>
    </footer>
  </div>
</template>
