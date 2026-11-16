<script setup lang="ts">
// Branches and worktrees of a project: a map (IuBranchGraph) and a table, with Remove worktree on idle merged or
// stale worktrees behind an in-page confirm.
import { computed, ref, watch } from 'vue'
import type { ProjectBranch, Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuBranchGraph } from '@/components/BranchGraph'
import { IuButton } from '@/components/Button'
import { IuDialog } from '@/components/Modal'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { IuTable, type Column } from '@/components/Table'
import { useToast } from '@/components/Toast'
import { relativeTime, shortHash } from '@/screens/shared/format'
import { useResource } from '@/screens/shared/useResource'
import {
  branchGraph,
  branchKind,
  canRemoveWorktree,
  KIND_LABEL,
  type BranchKind,
} from './branchGraph'

const props = defineProps<{ project: string; trunk: string; sessions: Session[] }>()

const api = useApi()
const { toast } = useToast()

const res = useResource<ProjectBranch[]>(() => api.listProjectBranches(props.project))
watch(
  () => props.project,
  () => (res.reset(), void res.load()),
  { immediate: true },
)

const now = ref(Date.now())
watch(res.data, () => (now.value = Date.now()))

const byId = computed(() => new Map(props.sessions.map(s => [s.id, s])))
const branches = computed(() => res.data.value ?? [])
const graph = computed(() => branchGraph(props.trunk, branches.value, byId.value, now.value))

const KIND_INTENT: Record<BranchKind, 'accent' | 'positive' | 'warning' | 'neutral'> = {
  current: 'accent',
  merged: 'positive',
  pull: 'accent',
  stale: 'warning',
  open: 'neutral',
}

type Row = {
  name: string
  worktree: string
  aheadBehind: string
  sessions: number
  pull: string
  lastCommitAt: string
  actions: string
}
const rows = computed<Row[]>(() =>
  branches.value.map(b => ({
    name: b.name,
    worktree: b.worktreePath ?? '',
    aheadBehind: `${b.ahead}/${b.behind}`,
    sessions: b.sessionIds.length,
    pull: b.pull ? `#${b.pull.number}` : '',
    lastCommitAt: b.lastCommitAt,
    actions: '',
  })),
)
const byName = computed(() => new Map(branches.value.map(b => [b.name, b])))
const columns: Column<Row>[] = [
  { key: 'name', header: 'Branch', sortable: true },
  { key: 'worktree', header: 'Worktree', width: '220px' },
  { key: 'aheadBehind', header: 'Ahead / behind', width: '120px', align: 'end' },
  { key: 'sessions', header: 'Sessions', width: '140px' },
  { key: 'pull', header: 'PR', width: '90px' },
  { key: 'lastCommitAt', header: 'Last commit', sortable: true, width: '120px' },
  { key: 'actions', header: '', width: '150px' },
]

const confirming = ref<ProjectBranch | null>(null)
const busy = ref(false)
const dialogOpen = computed({
  get: () => confirming.value !== null,
  set: v => {
    if (!v) confirming.value = null
  },
})
async function remove() {
  const b = confirming.value
  if (!b?.worktreePath) return
  busy.value = true
  try {
    await api.removeWorktree(props.project, b.worktreePath)
    confirming.value = null
    toast({
      title: 'Worktree removed',
      description: `${b.name} stays as a branch.`,
      intent: 'success',
    })
    await res.load()
  } catch (e) {
    toast({
      title: "Couldn't remove the worktree",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section aria-labelledby="project-branches" class="project-branches">
    <h2 id="project-branches" class="project-branches__heading">Branches</h2>
    <IuSkeleton v-if="res.phase.value === 'loading'" shape="card" :rows="3" />
    <IuErrorState
      v-else-if="res.phase.value === 'error'"
      title="Couldn't load the branches"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`project.branches.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />
    <IuEmpty
      v-else-if="!branches.length"
      title="No branches"
      body="Branches and worktrees of this project show up here."
    />
    <template v-else>
      <IuBranchGraph
        :trunk="graph.trunk"
        :branches="graph.branches"
        :aria-label="`Branches against ${trunk}`"
      />
      <IuTable
        :columns="columns"
        :rows="rows"
        :row-key="r => r.name"
        density="compact"
        min-width="900px"
      >
        <template #cell:name="{ row }">
          <span class="project-branches__name">
            <code class="project-branches__code">{{ row.name }}</code>
            <IuBadge
              v-if="byName.get(row.name)"
              :intent="KIND_INTENT[branchKind(byName.get(row.name)!, now)]"
              variant="tag"
              size="xs"
              >{{ KIND_LABEL[branchKind(byName.get(row.name)!, now)] }}</IuBadge
            >
          </span>
        </template>
        <template #cell:worktree="{ row }">
          <code v-if="row.worktree" class="project-branches__code" :title="row.worktree">{{
            row.worktree.split('/').slice(-2).join('/')
          }}</code>
          <span v-else class="project-branches__muted">None</span>
        </template>
        <template #cell:aheadBehind="{ row }">
          <span
            :aria-label="`${byName.get(row.name)?.ahead ?? 0} ahead, ${byName.get(row.name)?.behind ?? 0} behind`"
            >↑{{ byName.get(row.name)?.ahead }} ↓{{ byName.get(row.name)?.behind }}</span
          >
        </template>
        <template #cell:sessions="{ row }">
          <span class="project-branches__links">
            <template v-for="id in byName.get(row.name)?.sessionIds ?? []" :key="id">
              <RouterLink
                :to="{ name: 'session', params: { id } }"
                class="project-branches__link"
                >{{ byId.get(id)?.title ?? shortHash(id) }}</RouterLink
              >
            </template>
          </span>
        </template>
        <template #cell:pull="{ row }">
          <a
            v-if="byName.get(row.name)?.pull"
            :href="byName.get(row.name)!.pull!.url"
            target="_blank"
            rel="noopener noreferrer"
            class="project-branches__link"
            >{{ row.pull }}
            {{
              byName.get(row.name)!.pull!.merged ? 'merged' : byName.get(row.name)!.pull!.state
            }}</a
          >
        </template>
        <template #cell:lastCommitAt="{ row }">
          <time :datetime="row.lastCommitAt" :title="row.lastCommitAt">{{
            relativeTime(row.lastCommitAt)
          }}</time>
        </template>
        <template #cell:actions="{ row }">
          <IuButton
            v-if="byName.get(row.name) && canRemoveWorktree(byName.get(row.name)!, byId, now)"
            variant="secondary"
            size="sm"
            @click="confirming = byName.get(row.name)!"
            >Remove worktree</IuButton
          >
        </template>
      </IuTable>
    </template>

    <IuDialog v-model:open="dialogOpen" size="sm">
      <template #header>
        <h2 class="project-branches__heading">Remove worktree?</h2>
      </template>
      <p v-if="confirming" class="project-branches__text">
        The worktree at <code class="project-branches__code">{{ confirming.worktreePath }}</code> is
        deleted from disk. The branch
        <code class="project-branches__code">{{ confirming.name }}</code>
        and its commits stay.
      </p>
      <template #footer>
        <IuButton variant="ghost" @click="confirming = null">Cancel</IuButton>
        <IuButton variant="danger" :loading="busy" @click="remove">Remove worktree</IuButton>
      </template>
    </IuDialog>
  </section>
</template>

<style>
.project-branches {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.project-branches__heading {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.project-branches__name,
.project-branches__links {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
}
.project-branches__code {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.project-branches__muted {
  color: var(--iu-text-muted);
}
.project-branches__text {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.project-branches__link:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
</style>
