<script setup lang="ts">
// The pull request overview shown on hover in the Details header: state, branch, and what the session changed.
import { computed } from 'vue'
import type { PullRef, SessionDetail } from '@odin/shared/api'
import { IuIcon } from '@/components/Icon'
import { PULL_STATE, pullTone } from './pullState'
import './hovercards.css'

const props = defineProps<{ pull: PullRef; session: SessionDetail }>()

const tone = computed(() => pullTone(props.pull))
const state = computed(() => PULL_STATE[tone.value])
// owner/repo from the PR's own URL, so the card needs no project lookup.
const repo = computed(() => /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(props.pull.url)?.[1] ?? null)
const diff = computed(() => props.session.metrics.diff)
</script>

<template>
  <div class="hc">
    <header class="hc__head">
      <IuIcon :name="state.icon" :size="14" :class="`hc__tone--${tone}`" />
      <span class="hc__title">PR #{{ pull.number }}</span>
      <span :class="`hc__tone--${tone}`">{{ state.label }}</span>
    </header>
    <dl class="hc__props">
      <div v-if="repo">
        <dt><IuIcon name="link" :size="14" /><span class="hc__sr">Repository</span></dt>
        <dd class="hc__mono">{{ repo }}</dd>
      </div>
      <div v-if="session.branch">
        <dt><IuIcon name="gitBranch" :size="14" /><span class="hc__sr">Branch</span></dt>
        <dd class="hc__mono">{{ session.branch }}</dd>
      </div>
      <div v-if="diff">
        <dt><IuIcon name="file" :size="14" /><span class="hc__sr">Changes</span></dt>
        <dd class="hc__mono">
          <span class="hc__added">+{{ diff.added }}</span>
          <span class="hc__removed">−{{ diff.removed }}</span>
          <span class="hc__dim"> · {{ diff.files }} {{ diff.files === 1 ? 'file' : 'files' }}</span>
        </dd>
      </div>
      <div v-if="session.metrics.commits !== null">
        <dt><IuIcon name="gitCommit" :size="14" /><span class="hc__sr">Commits</span></dt>
        <dd>
          {{ session.metrics.commits }} {{ session.metrics.commits === 1 ? 'commit' : 'commits' }}
        </dd>
      </div>
    </dl>
  </div>
</template>
