<script setup lang="ts">
// A project's sessions: the ones it has (with the other projects each touches), terminal sessions the harness knows
// about, and its branches and worktrees. Start chat lives in the project header.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { useSessions } from '@/app/sessions'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuSwitch } from '@/components/Fields'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { useToast } from '@/components/Toast'
import SessionsTable from '@/screens/shared/SessionsTable.vue'
import { plural } from '@/screens/shared/format'
import { useResource } from '@/screens/shared/useResource'
import { useProject } from '../useProject'
import BranchesSection from './BranchesSection.vue'

const api = useApi()
const live = useSessions()
const { toast } = useToast()
const { detail } = useProject()
const name = computed(() => detail.value.name)

const archived = ref(false)
const res = useResource<Session[]>(() =>
  api.listSessions({ project: name.value, archived: archived.value }),
)
watch([name, archived], () => void res.load(), { immediate: true })

let timer: ReturnType<typeof setTimeout> | undefined
watch(live.revision, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void res.load(), 250)
})
onBeforeUnmount(() => clearTimeout(timer))

const sessions = computed(() => res.data.value ?? [])

const finding = ref(false)
async function findTerminalSessions() {
  finding.value = true
  try {
    const { added } = await api.discoverSessions(name.value)
    toast({
      title: added ? `Found ${plural(added, 'terminal session')}` : 'No new terminal sessions',
      description: added ? 'They are in the list below.' : undefined,
      intent: added ? 'success' : 'info',
    })
    if (added) await res.load()
  } catch (e) {
    toast({
      title: "Couldn't look for terminal sessions",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    finding.value = false
  }
}
</script>

<template>
  <div class="project-sessions">
    <section aria-labelledby="project-sessions-list" class="project-sessions__list">
      <div class="project-sessions__bar">
        <h2 id="project-sessions-list" class="project-sessions__heading">Sessions</h2>
        <div class="project-sessions__tools">
          <IuSwitch v-model="archived" label="Archived" />
          <IuButton variant="secondary" size="sm" :loading="finding" @click="findTerminalSessions">
            <template #icon><IuIcon name="search" :size="14" /></template>
            Find terminal sessions
          </IuButton>
        </div>
      </div>

      <IuSkeleton v-if="res.phase.value === 'loading'" shape="table" :rows="4" />
      <IuErrorState
        v-else-if="res.phase.value === 'error'"
        title="Couldn't load the sessions"
        :body="res.error.value?.message ?? 'Unknown error'"
        :trace-id="`project.sessions.${res.error.value?.status ?? 0}`"
        @retry="res.load()"
      />
      <IuEmpty
        v-else-if="!sessions.length"
        :title="archived ? 'Nothing archived' : 'No sessions yet'"
        :body="
          archived
            ? 'Archived sessions of this project show up here.'
            : 'Start a chat, or find the ones you ran from a terminal.'
        "
      />
      <SessionsTable v-else :sessions="sessions" :other-projects-of="name" @changed="res.load()" />
    </section>

    <BranchesSection :project="name" :trunk="detail.settings.defaultBranch" :sessions="sessions" />
  </div>
</template>

<style>
.project-sessions {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-top: 8px;
}
.project-sessions__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.project-sessions__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.project-sessions__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}
.project-sessions__heading {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
</style>
