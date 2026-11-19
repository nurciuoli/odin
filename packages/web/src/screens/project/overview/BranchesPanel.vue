<script setup lang="ts">
// Local branches against the default branch. Git projects only; removing worktrees stays in the Sessions tab.
import { computed, ref } from 'vue'
import type { ProjectBranch, Session } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuSegmented } from '@/components/Segmented'
import { IuEmpty, IuErrorState } from '@/components/States'
import { IuTable, type Column } from '@/components/Table'
import type { LoadError } from '@/screens/shared/useResource'
import { plural, relativeTime } from '@/screens/shared/format'
import BranchTree from './BranchTree.vue'
import type { TreeDensity, TreeFilter } from './branchTree'
import OverviewPanel from './OverviewPanel.vue'

const props = defineProps<{
  branches: ProjectBranch[] | null
  defaultBranch: string
  /** GitHub owner/name; null hides the GitHub links. */
  repo?: string | null
  sessions?: Session[] | null
  loading: boolean
  error: LoadError | null
}>()
const emit = defineEmits<{ retry: [] }>()

const view = ref('tree')
const filter = ref<TreeFilter>('active')
const worktreesOnly = ref(false)
const density = ref<TreeDensity>('comfortable')
const hasWorktrees = computed(() => (props.branches ?? []).some(b => b.worktreePath && !b.current))

const STALE_MS = 30 * 24 * 60 * 60 * 1000

interface Row extends Record<string, unknown> {
  name: string
  ahead: number
  behind: number
  last: string
  tags: string[]
  stale: boolean
  pull: ProjectBranch['pull']
}
const rows = computed<Row[]>(() => {
  const now = Date.now()
  return [...(props.branches ?? [])]
    .filter(b => {
      if (b.name === props.defaultBranch) return true
      if (filter.value === 'active' && b.merged) return false
      if (filter.value === 'merged' && !b.merged) return false
      return !worktreesOnly.value || (b.worktreePath !== null && !b.current)
    })
    .sort(
      (a, b) =>
        Number(b.name === props.defaultBranch) - Number(a.name === props.defaultBranch) ||
        b.lastCommitAt.localeCompare(a.lastCommitAt),
    )
    .map(b => {
      const isDefault = b.name === props.defaultBranch
      const tags = [
        isDefault ? 'default' : null,
        b.current && !isDefault ? 'current' : null,
        b.worktreePath && !b.current ? 'worktree' : null,
        b.merged && !isDefault ? 'merged' : null,
      ].filter((t): t is string => t !== null)
      return {
        name: b.name,
        ahead: b.ahead,
        behind: b.behind,
        last: b.lastCommitAt,
        tags,
        stale: !isDefault && !b.merged && now - Date.parse(b.lastCommitAt) > STALE_MS,
        pull: b.pull,
      }
    })
})
const columns: Column<Row>[] = [
  { key: 'name', header: 'Branch' },
  { key: 'ahead', header: 'Ahead', align: 'end', numeric: true },
  { key: 'behind', header: 'Behind', align: 'end', numeric: true },
  { key: 'last', header: 'Last commit' },
  { key: 'tags', header: 'State' },
]
const summary = computed(() => {
  const list = props.branches ?? []
  const wt = list.filter(b => b.worktreePath && !b.current).length
  return `${list.length} local${wt ? ` · ${plural(wt, 'worktree')}` : ''}`
})
</script>

<template>
  <OverviewPanel id="overview-branches" title="Branches">
    <template v-if="branches" #actions>
      <span class="ov-branches__note">{{ summary }}</span>
    </template>
    <div v-if="branches?.length" class="ov-branches__bar">
      <IuSegmented
        v-model="view"
        label="View"
        :options="[
          { value: 'tree', label: 'Graph' },
          { value: 'list', label: 'List' },
        ]"
      />
      <IuSegmented
        v-model="filter"
        label="Show"
        :options="[
          { value: 'active', label: 'Active' },
          { value: 'merged', label: 'Merged' },
          { value: 'all', label: 'All' },
        ]"
      />
      <IuButton
        v-if="hasWorktrees"
        size="sm"
        :variant="worktreesOnly ? 'primary' : 'secondary'"
        :aria-pressed="worktreesOnly"
        @click="worktreesOnly = !worktreesOnly"
        >Worktrees</IuButton
      >
      <IuSegmented
        v-if="view === 'tree'"
        v-model="density"
        label="Zoom"
        :options="[
          { value: 'comfortable', label: 'Detailed' },
          { value: 'compact', label: 'Compact' },
        ]"
      />
    </div>
    <IuErrorState
      v-if="error && !branches"
      title="Couldn't load the branches"
      :body="error.message"
      :trace-id="`project.branches.${error.status}`"
      @retry="emit('retry')"
    />
    <IuEmpty
      v-else-if="!loading && !rows.length"
      title="No local branches"
      body="Branches show up here once the repository has a commit."
    />
    <BranchTree
      v-else-if="view === 'tree' && branches"
      :branches="branches"
      :default-branch="defaultBranch"
      :repo="repo ?? null"
      :sessions="sessions ?? []"
      :filter="filter"
      :worktrees-only="worktreesOnly"
      :density="density"
      @show-merged="filter = 'all'"
    />
    <IuTable
      v-else
      :columns="columns"
      :rows="rows"
      :row-key="r => r.name"
      :loading="loading && !branches"
      :sticky-header="false"
      density="compact"
      min-width="480px"
    >
      <template #cell:name="{ row }">
        <code class="ov-branches__mono">{{ row.name }}</code>
      </template>
      <template #cell:last="{ row }">
        <time :datetime="row.last">{{ relativeTime(row.last) }}</time>
      </template>
      <template #cell:tags="{ row }">
        <span class="ov-branches__tags">
          <IuBadge v-for="t in row.tags" :key="t" variant="tag" size="xs">{{ t }}</IuBadge>
          <IuBadge v-if="row.stale" variant="tag" size="xs" intent="warning">stale</IuBadge>
          <a
            v-if="row.pull"
            :href="row.pull.url"
            target="_blank"
            rel="noopener noreferrer"
            class="ov-branches__pr"
            >PR #{{ row.pull.number }}</a
          >
        </span>
      </template>
    </IuTable>
  </OverviewPanel>
</template>

<style>
.ov-branches__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.ov-branches__note {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.ov-branches__mono {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  white-space: nowrap;
}
.ov-branches__tags {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.ov-branches__pr {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text);
}
.ov-branches__pr:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
</style>
