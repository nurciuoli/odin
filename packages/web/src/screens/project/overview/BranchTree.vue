<script setup lang="ts">
// Branch tree: the default branch as a trunk down the left, open branches as short elbows that rejoin it, merged
// branches as rings on it. Newest first. Lines are SVG (hidden from assistive tech); every fact is also real text or a
// link in the row: GitHub branch/commit/PR, the local worktree, and the Odin sessions on that branch. Nothing
// animates, and state is words and line style, never colour alone.
import { computed, ref } from 'vue'
import type { ProjectBranch, Session } from '@odin/shared/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { relativeTime, shortHash } from '@/screens/shared/format'
import {
  branchUrl,
  commitUrl,
  LANES,
  ROW_HEIGHT,
  treeRows,
  type TreeDensity,
  type TreeFilter,
} from './branchTree'

const props = defineProps<{
  branches: ProjectBranch[]
  defaultBranch: string
  repo: string | null
  sessions: Session[]
  filter: TreeFilter
  worktreesOnly: boolean
  density: TreeDensity
}>()
const emit = defineEmits<{ showMerged: [] }>()

// A busy branch (main can carry dozens of sessions) would squeeze its chips down to circled first letters that pile
// up over the name; show the first few and fold the rest into one "+N sessions" chip whose tooltip lists them.
const MAX_SESSION_CHIPS = 2
const MORE_TITLES = 12
const LANE_GAP = 14
const PAD = 12
const laneX = (l: number) => PAD + l * LANE_GAP
const gutter = PAD * 2 + LANES * LANE_GAP - 8

const rows = computed(() =>
  treeRows(props.branches, props.defaultBranch, {
    filter: props.filter,
    worktreesOnly: props.worktreesOnly,
  }),
)
const hiddenMerged = computed(() =>
  props.filter === 'active'
    ? props.branches.filter(b => b.merged && b.name !== props.defaultBranch).length
    : 0,
)
const h = computed(() => ROW_HEIGHT[props.density])
const height = computed(() => rows.value.length * h.value)
const titles = computed(() => new Map(props.sessions.map(s => [s.id, s.title])))
const active = ref<string | null>(null)
function moreTitle(ids: string[]): string {
  const rest = ids.slice(MAX_SESSION_CHIPS)
  const names = rest.slice(0, MORE_TITLES).map(id => titles.value.get(id) ?? shortHash(id))
  const more = rest.length - names.length
  return names.join('\n') + (more > 0 ? `\n…and ${more} more` : '')
}
const cy = (i: number) => i * h.value + h.value / 2

function elbow(i: number, lane: number): string {
  const x = laneX(lane)
  const y = cy(i)
  const H = h.value
  return `M${x} ${y} V${y + H * 0.35} C${x} ${y + H * 0.8} ${laneX(0)} ${y + H * 0.55} ${laneX(0)} ${y + H}`
}
</script>

<template>
  <div class="ov-tree" :data-density="density">
    <p v-if="!rows.length" class="ov-tree__empty">No branches match these filters.</p>
    <div v-else class="ov-tree__wrap">
      <svg
        class="ov-tree__svg"
        :width="gutter"
        :height="height"
        :viewBox="`0 0 ${gutter} ${height}`"
        aria-hidden="true"
      >
        <line class="ov-tree__trunk" :x1="laneX(0)" :y1="cy(0)" :x2="laneX(0)" :y2="height" />
        <g
          v-for="(r, i) in rows"
          :key="r.branch.name"
          :data-active="active === r.branch.name || undefined"
        >
          <path
            v-if="r.kind === 'active'"
            class="ov-tree__line"
            :d="elbow(i, r.lane)"
            :data-dashed="r.stale || undefined"
          />
          <circle
            class="ov-tree__node"
            :data-kind="r.kind"
            :cx="laneX(r.lane)"
            :cy="cy(i)"
            :r="r.kind === 'default' ? 6 : 5"
          />
        </g>
      </svg>
      <ul class="ov-tree__list" :aria-label="`${rows.length} branches, newest first`">
        <li
          v-for="r in rows"
          :key="r.branch.name"
          class="ov-tree__row"
          :style="{ height: `${h}px`, paddingLeft: `${gutter}px` }"
          :data-kind="r.kind"
          @mouseenter="active = r.branch.name"
          @mouseleave="active = null"
          @focusin="active = r.branch.name"
          @focusout="active = null"
        >
          <span class="ov-tree__main">
            <span class="ov-tree__name">
              <a
                v-if="branchUrl(repo, r.branch.name)"
                :href="branchUrl(repo, r.branch.name)!"
                target="_blank"
                rel="noopener noreferrer"
                class="ov-tree__link ov-tree__code"
                :title="`${r.branch.name} on GitHub`"
                >{{ r.branch.name }}</a
              >
              <code v-else class="ov-tree__code" :title="r.branch.name">{{ r.branch.name }}</code>
              <IuBadge v-if="r.kind === 'default'" variant="tag" size="xs">default</IuBadge>
              <IuBadge v-else-if="r.branch.current" variant="tag" size="xs">current</IuBadge>
              <IuBadge
                v-if="r.worktree"
                variant="tag"
                size="xs"
                :title="r.branch.worktreePath ?? ''"
                >worktree</IuBadge
              >
              <IuBadge v-if="r.kind === 'merged'" variant="tag" size="xs">merged</IuBadge>
              <IuBadge v-if="r.stale" variant="tag" size="xs" intent="warning">stale</IuBadge>
            </span>
            <span v-if="density === 'comfortable'" class="ov-tree__meta">
              <a
                v-if="commitUrl(repo, r.branch.headSha)"
                :href="commitUrl(repo, r.branch.headSha)!"
                target="_blank"
                rel="noopener noreferrer"
                class="ov-tree__link ov-tree__sha"
                >{{ shortHash(r.branch.headSha) }}</a
              >
              <code v-else class="ov-tree__sha">{{ shortHash(r.branch.headSha) }}</code>
              <span aria-hidden="true">·</span>
              <time :datetime="r.branch.lastCommitAt" :title="r.branch.lastCommitAt">{{
                relativeTime(r.branch.lastCommitAt)
              }}</time>
            </span>
          </span>
          <span class="ov-tree__side">
            <span
              v-if="r.kind !== 'default' && (r.branch.ahead || r.branch.behind)"
              class="ov-tree__delta"
              :title="`${r.branch.ahead} ahead, ${r.branch.behind} behind ${defaultBranch}`"
              >↑{{ r.branch.ahead }} ↓{{ r.branch.behind }}</span
            >
            <time
              v-if="density === 'compact'"
              class="ov-tree__when"
              :datetime="r.branch.lastCommitAt"
              >{{ relativeTime(r.branch.lastCommitAt) }}</time
            >
            <RouterLink
              v-for="id in r.branch.sessionIds.slice(0, MAX_SESSION_CHIPS)"
              :key="id"
              :to="{ name: 'session', params: { id } }"
              class="ov-tree__chip"
              :title="`Open session: ${titles.get(id) ?? id}`"
              >{{ titles.get(id) ?? shortHash(id) }}</RouterLink
            >
            <span
              v-if="r.branch.sessionIds.length > MAX_SESSION_CHIPS"
              class="ov-tree__chip ov-tree__chip--more"
              :title="moreTitle(r.branch.sessionIds)"
              >+{{ r.branch.sessionIds.length - MAX_SESSION_CHIPS }} sessions</span
            >
            <a
              v-if="r.branch.pull"
              :href="r.branch.pull.url"
              target="_blank"
              rel="noopener noreferrer"
              class="ov-tree__chip ov-tree__chip--pr"
              :data-state="r.branch.pull.merged ? 'merged' : r.branch.pull.state"
              >PR #{{ r.branch.pull.number }}
              {{ r.branch.pull.merged ? 'merged' : r.branch.pull.state }}</a
            >
          </span>
        </li>
      </ul>
    </div>
    <div v-if="hiddenMerged" class="ov-tree__more">
      <IuButton variant="ghost" size="sm" @click="emit('showMerged')"
        >Show {{ hiddenMerged }} merged</IuButton
      >
    </div>
  </div>
</template>

<style>
.ov-tree__wrap {
  position: relative;
  min-width: 0;
}
.ov-tree__svg {
  position: absolute;
  top: 0;
  left: 0;
}
.ov-tree__trunk,
.ov-tree__line {
  fill: none;
  stroke: var(--iu-border-strong);
  stroke-width: 2;
}
.ov-tree__line[data-dashed] {
  stroke-dasharray: 3 3;
}
g[data-active] .ov-tree__line,
g[data-active] .ov-tree__node {
  stroke: var(--iu-text);
}
.ov-tree__node {
  stroke-width: 2;
}
.ov-tree__node[data-kind='default'] {
  fill: var(--iu-text);
  stroke: var(--iu-text);
}
.ov-tree__node[data-kind='active'] {
  fill: var(--iu-surface);
  stroke: var(--iu-info);
}
.ov-tree__node[data-kind='merged'] {
  fill: var(--iu-surface);
  stroke: var(--iu-positive);
}
.ov-tree__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.ov-tree__row {
  position: relative;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-radius: var(--iu-radius-sm, 4px);
}
.ov-tree__row:hover,
.ov-tree__row:focus-within {
  background: var(--iu-surface-raised);
}
.ov-tree__main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ov-tree__name,
.ov-tree__side,
.ov-tree__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ov-tree__name {
  flex-wrap: nowrap;
}
.ov-tree__name > .iu-badge {
  flex-shrink: 0;
}
.ov-tree__side {
  flex-wrap: nowrap;
  justify-content: flex-end;
  flex-shrink: 1;
  max-width: 70%;
}
.ov-tree__delta {
  white-space: nowrap;
}
.ov-tree__code,
.ov-tree__sha,
.ov-tree__delta {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.ov-tree__code {
  color: var(--iu-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.ov-tree__meta,
.ov-tree__delta,
.ov-tree__when {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.ov-tree__link {
  color: inherit;
  text-decoration: none;
}
.ov-tree__link:hover {
  text-decoration: underline;
}
.ov-tree__chip {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  border: 1px solid var(--iu-border);
  border-radius: 999px;
  padding: 0 8px;
  max-width: 140px;
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-decoration: none;
}
.ov-tree__chip:hover {
  border-color: var(--iu-border-strong);
  color: var(--iu-text);
}
.ov-tree__chip--more {
  flex-shrink: 0;
  max-width: none;
  color: var(--iu-text-muted);
  cursor: default;
}
.ov-tree__chip--pr {
  flex-shrink: 0;
  max-width: none;
}
.ov-tree__chip--pr[data-state='open'] {
  border-color: var(--iu-positive-border);
}
.ov-tree__chip--pr[data-state='merged'] {
  border-color: var(--iu-info-border);
}
.ov-tree__link:focus-visible,
.ov-tree__chip:focus-visible {
  outline: 2px solid var(--iu-text-2);
  outline-offset: 2px;
}
.ov-tree__more {
  display: flex;
  justify-content: center;
  padding-top: 8px;
}
.ov-tree__empty {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-13);
}
@media (max-width: 640px) {
  .ov-tree__side {
    display: none;
  }
}
</style>
