<script setup lang="ts">
// The branch and its upstream have both moved: shows what's coming in, and pulls with the chosen strategy, then
// optionally pushes. Uncommitted changes are set aside during the pull and put back after (git's --autostash).
import { computed, ref, watch } from 'vue'
import type { GitCommit, GitStatus, GitTarget } from '@odin/shared/git'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuDialog } from '@/components/Modal'
import { IuSegmented } from '@/components/Segmented'
import { relativeTime } from './useGit'

type Strategy = 'ff-only' | 'rebase' | 'merge'
const props = defineProps<{ target: GitTarget; status: GitStatus | null }>()
const emit = defineEmits<{ sync: [req: { strategy: Strategy; push: boolean }] }>()
const open = defineModel<boolean>('open', { required: true })

const api = useApi()
const strategy = ref<Strategy>('rebase')
const incoming = ref<GitCommit[]>([])
const more = ref(false)
watch(
  open,
  async v => {
    if (!v) return
    incoming.value = []
    try {
      const log = await api.gitLog(props.target, { ref: 'HEAD..@{u}', limit: 3 })
      incoming.value = log.commits
      more.value = log.more
    } catch {
      // the counts still say what's there
    }
  },
  { immediate: true },
)

const ahead = computed(() => props.status?.ahead ?? 0)
const behind = computed(() => props.status?.behind ?? 0)
const dirty = computed(() => {
  const s = props.status
  return s ? new Set([...s.staged, ...s.unstaged].map(c => c.path)).size : 0
})
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
const strategies = [
  { value: 'rebase', label: 'Rebase' },
  { value: 'merge', label: 'Merge' },
  { value: 'ff-only', label: 'Fast-forward only', disabled: true },
]
</script>

<template>
  <IuDialog v-model:open="open" size="sm">
    <template #header>
      <div class="sync-dialog__head">
        <h2 class="sync-dialog__title">Branch has diverged</h2>
        <span class="sync-dialog__ab">
          <span class="sync-dialog__up">↑{{ ahead }}</span>
          <span class="sync-dialog__down">↓{{ behind }}</span>
        </span>
      </div>
    </template>
    <p class="sync-dialog__lede">
      Your {{ plural(ahead, 'commit') }} and {{ plural(behind, 'new commit') }} on
      {{ status?.upstream ?? 'the remote' }}. Pull first, then push.
    </p>
    <ul v-if="incoming.length" class="sync-dialog__incoming" aria-label="Incoming commits">
      <li v-for="c in incoming" :key="c.sha" class="sync-dialog__commit">
        <span class="sync-dialog__down"><IuIcon name="arrowDown" :size="14" /></span>
        <span class="sync-dialog__subject">{{ c.subject }}</span>
        <span class="sync-dialog__meta"
          >{{ c.author }} · {{ c.shortSha }} · {{ relativeTime(c.at) }}</span
        >
      </li>
      <li v-if="more" class="sync-dialog__meta">and more</li>
    </ul>
    <div class="sync-dialog__strategy">
      <span class="sync-dialog__label">Pull with</span>
      <IuSegmented v-model="strategy" :options="strategies" label="Pull strategy" />
    </div>
    <p v-if="dirty" class="sync-dialog__note">
      {{ plural(dirty, 'uncommitted file') }} {{ dirty === 1 ? 'is' : 'are' }} set aside during the
      pull and put back after.
    </p>
    <template #footer>
      <IuButton variant="ghost" size="sm" @click="open = false">Cancel</IuButton>
      <IuButton variant="secondary" size="sm" @click="emit('sync', { strategy, push: false })"
        >Pull only</IuButton
      >
      <IuButton variant="primary" size="sm" @click="emit('sync', { strategy, push: true })">
        Pull and push
      </IuButton>
    </template>
  </IuDialog>
</template>

<style>
.sync-dialog__head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.sync-dialog__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.sync-dialog__ab {
  display: inline-flex;
  gap: 6px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.sync-dialog__up {
  color: var(--iu-positive);
}
.sync-dialog__down {
  color: var(--iu-info);
  display: inline-flex;
}
.sync-dialog__lede {
  margin: 0 0 12px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.sync-dialog__incoming {
  margin: 0 0 14px;
  padding: 8px 10px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  background: var(--iu-well);
}
.sync-dialog__commit {
  display: grid;
  grid-template-columns: 18px 1fr;
  column-gap: 6px;
  font-size: var(--iu-font-size-13);
}
.sync-dialog__subject {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-dialog__commit .sync-dialog__meta {
  grid-column: 2;
}
.sync-dialog__meta {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}
.sync-dialog__strategy {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.sync-dialog__label {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.sync-dialog__note {
  margin: 12px 0 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
