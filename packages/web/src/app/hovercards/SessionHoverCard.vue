<script setup lang="ts">
// The session overview shown on hover: what it is, how it's going, and where it left off.
import { computed, onMounted, shallowRef } from 'vue'
import type { Session, SessionDetail } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { IuIcon } from '@/components/Icon'
import { IuMeter } from '@/components/Meter'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import { useApi } from '@/api'
import {
  SESSION_DISPLAY,
  formatCost,
  formatTokens,
  harnessLabel,
  relativeTime,
} from '@/screens/shared/format'
import { hoverVariant } from './variant'
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
const needs = computed(() =>
  props.session.waitingFor === 'permission'
    ? 'Waiting for a permission'
    : props.session.waitingFor === 'question'
      ? 'Waiting for your answer'
      : '',
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
  <div class="hc" :class="`hc--${hoverVariant}`">
    <header class="hc__head">
      <IuStatusDot :status="display.status" :size="9" decorative />
      <span class="hc__title">{{ session.title }}</span>
    </header>
    <p class="hc__state">
      <span class="hc__strong">{{ needs || display.label }}</span>
      <span class="hc__dim"> · updated {{ relativeTime(session.updatedAt) }}</span>
    </p>

    <dl class="hc__props">
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
        <dd class="hc__mono">{{ session.branch }}</dd>
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

    <footer v-if="hoverVariant === 'a'" class="hc__foot">
      <span v-if="cost" class="hc__mono">{{ cost }}</span>
      <span v-if="ctx" class="hc__mono">{{ Math.round((ctx.used / ctx.max) * 100) }}% context</span>
      <span v-if="session.pull" class="hc__mono">PR #{{ session.pull.number }}</span>
      <IuBadge v-for="t in session.tags.slice(0, 2)" :key="t" variant="tag" size="xs">{{
        t
      }}</IuBadge>
    </footer>
    <section v-else class="hc__stats" aria-label="Usage">
      <IuMeter
        v-if="ctx"
        label="Context"
        :value="ctx.used"
        :max="ctx.max"
        :value-label="`${formatTokens(ctx.used)} / ${formatTokens(ctx.max)}`"
        layout="stacked"
        size="sm"
      />
      <div class="hc__tiles">
        <div>
          <span class="hc__tile-n hc__mono">{{ cost || '—' }}</span
          ><span class="hc__dim">cost</span>
        </div>
        <div>
          <span class="hc__tile-n hc__mono">{{ metrics.turns }}</span
          ><span class="hc__dim">turns</span>
        </div>
        <div v-if="metrics.diff">
          <span class="hc__tile-n hc__mono">{{ metrics.diff.files }}</span
          ><span class="hc__dim">files</span>
        </div>
      </div>
    </section>
  </div>
</template>
