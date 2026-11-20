<script setup lang="ts">
// The branch overview on the Details row: upstream, ahead and behind, and the commit at HEAD.
import { onMounted, ref } from 'vue'
import type { GitCommit, GitStatus, GitTarget } from '@odin/shared/git'
import { useApi } from '@/api'
import { IuIcon } from '@/components/Icon'
import { shortHash } from '@/screens/shared/format'
import '@/app/hovercards/hovercards.css'

const props = defineProps<{
  status: GitStatus
  changed: number
  target: GitTarget
}>()

const api = useApi()
const commit = ref<GitCommit | null>(null)
onMounted(() => {
  api
    .gitLog(props.target, { limit: 1 })
    .then(log => (commit.value = log.commits[0] ?? null))
    .catch(() => {})
})

const branch = () =>
  props.status.branch ?? (props.status.headSha ? shortHash(props.status.headSha) : 'detached')
const upstream = () => {
  const status = props.status
  if (status.upstreamGone) return `${status.upstream} is gone`
  return status.upstream ?? 'Not pushed yet'
}
const sync = () => {
  const status = props.status
  const parts: string[] = []
  if (status.ahead) parts.push(`${status.ahead} to push`)
  if (status.behind) parts.push(`${status.behind} to pull`)
  if (!status.ahead && !status.behind) parts.push(status.upstream ? 'in sync' : 'no upstream')
  parts.push(
    props.changed ? `${props.changed} ${props.changed === 1 ? 'file' : 'files'} changed` : 'clean',
  )
  return parts.join(' · ')
}
</script>

<template>
  <div class="hc">
    <header class="hc__head">
      <span class="hc__title hc__mono">{{ branch() }}</span>
    </header>
    <dl class="hc__props">
      <div>
        <dt><IuIcon name="link" :size="14" /><span class="hc__sr">Upstream</span></dt>
        <dd class="hc__mono">{{ upstream() }}</dd>
      </div>
      <div>
        <dt><IuIcon name="gitCommit" :size="14" /><span class="hc__sr">Status</span></dt>
        <dd>{{ sync() }}</dd>
      </div>
      <div v-if="commit || status.headSha">
        <dt><IuIcon name="gitBranch" :size="14" /><span class="hc__sr">Commit</span></dt>
        <dd class="hc__mono">
          {{ shortHash(commit?.sha ?? status.headSha ?? '') }}
          <span v-if="commit" class="hc__dim">{{ commit.subject }}</span>
        </dd>
      </div>
    </dl>
    <p class="hc__state">Click the name to switch, fetch, pull, or push.</p>
  </div>
</template>
