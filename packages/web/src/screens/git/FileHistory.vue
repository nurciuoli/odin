<script setup lang="ts">
// One file's commits, newest first (renames followed), with the picked commit's change to the file beside them.
// Commits from an Odin session name the session and turn.
import { ref, watch } from 'vue'
import type { GitCommit, GitFileDiff, GitTarget } from '@odin/shared/git'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import DiffView from './DiffView.vue'
import { relativeTime } from './useGit'
import { useSessionTitles } from './useSessionTitles'

const props = defineProps<{ target: GitTarget; path: string; sha?: string | null }>()

const PAGE = 30
const api = useApi()
const titles = useSessionTitles()
const commits = ref<GitCommit[]>([])
const more = ref(false)
const loading = ref(false)
const error = ref<string | null>(null)
const picked = ref<string | null>(null)
const diff = ref<GitFileDiff | null>(null)
const body = ref('')

async function load(skip = 0) {
  loading.value = true
  error.value = null
  try {
    const log = await api.gitLog(props.target, { path: props.path, limit: PAGE, skip })
    commits.value = skip ? [...commits.value, ...log.commits] : log.commits
    more.value = log.more
    for (const c of log.commits) if (c.sessionId) titles.want(c.sessionId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}
let showing = 0
async function pick(sha: string) {
  picked.value = sha
  const id = ++showing
  diff.value = null
  try {
    const detail = await api.gitShow(props.target, sha, props.path)
    if (id !== showing) return
    diff.value = detail.diffs[0] ?? null
    body.value = detail.commit.body
  } catch {
    if (id === showing) diff.value = null
  }
}
watch(
  () => [props.target.kind, props.target.id, props.path] as const,
  async () => {
    picked.value = null
    diff.value = null
    await load()
    const first = props.sha ?? commits.value[0]?.sha
    if (first) void pick(first)
  },
  { immediate: true },
)
watch(
  () => props.sha,
  sha => {
    if (sha) void pick(sha)
  },
)

const sessionLine = (c: GitCommit) =>
  `${titles.title(c.sessionId!) ?? 'Odin session'}${c.turns ? ` · T${c.turns}` : ''}`
</script>

<template>
  <div class="git-history">
    <div class="git-history__grid">
      <div class="git-history__list" role="listbox" :aria-label="`Commits that changed ${path}`">
        <p v-if="error" class="git-history__note">Can't load history: {{ error }}</p>
        <p v-else-if="!loading && !commits.length" class="git-history__note">
          No commits touch this file yet.
        </p>
        <button
          v-for="c in commits"
          :key="c.sha"
          type="button"
          role="option"
          class="git-history__row"
          :class="{ 'git-history__row--on': picked === c.sha || picked === c.shortSha }"
          :aria-selected="picked === c.sha || picked === c.shortSha"
          @click="pick(c.sha)"
        >
          <IuIcon :name="c.sessionId ? 'terminal' : 'gitCommit'" :size="14" />
          <span class="git-history__text">
            <span class="git-history__subject">{{ c.subject }}</span>
            <span class="git-history__meta">
              <span>{{ c.sessionId ? sessionLine(c) : c.author }}</span>
              <span>{{ c.shortSha }}</span>
              <span>{{ relativeTime(c.at) }}</span>
            </span>
          </span>
          <span v-if="c.additions !== null" class="git-history__num">
            <span class="git-history__add">+{{ c.additions }}</span>
            <span class="git-history__del">−{{ c.deletions }}</span>
          </span>
        </button>
        <div v-if="more" class="git-history__more">
          <IuButton size="sm" variant="ghost" :loading="loading" @click="load(commits.length)"
            >Load more</IuButton
          >
        </div>
      </div>
      <div class="git-history__diff">
        <p v-if="body" class="git-history__body">{{ body }}</p>
        <DiffView :diff="diff" mode="readonly" />
      </div>
    </div>
  </div>
</template>

<style>
.git-history {
  container-type: inline-size;
  height: 100%;
}
.git-history__grid {
  display: grid;
  height: 100%;
  grid-template-columns: minmax(260px, 40%) 1fr;
  min-height: 100%;
}
.git-history__list {
  min-width: 0;
  border-right: 1px solid var(--iu-hairline);
  overflow-y: auto;
}
.git-history__note {
  margin: 0;
  padding: 16px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.git-history__row {
  display: grid;
  grid-template-columns: 16px 1fr auto;
  gap: 8px;
  align-items: start;
  width: 100%;
  padding: 9px 12px;
  border: 0;
  border-bottom: 1px solid var(--iu-hairline);
  background: transparent;
  font: inherit;
  text-align: left;
  color: var(--iu-text-2);
  cursor: pointer;
}
.git-history__row:hover {
  background: var(--iu-hover);
}
.git-history__row--on {
  background: var(--iu-accent-wash);
  color: var(--iu-text);
}
.git-history__row:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: -2px;
}
.git-history__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.git-history__subject {
  font-size: var(--iu-font-size-13);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-history__meta {
  display: flex;
  gap: 8px;
  min-width: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  overflow: hidden;
  white-space: nowrap;
}
.git-history__num {
  display: flex;
  gap: 4px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
}
.git-history__add {
  color: var(--iu-positive);
}
.git-history__del {
  color: var(--iu-danger);
}
.git-history__more {
  padding: 8px;
  display: flex;
  justify-content: center;
}
.git-history__diff {
  min-width: 0;
  overflow: auto;
  background: var(--iu-well);
}
.git-history__body {
  margin: 0;
  padding: 10px 14px;
  border-bottom: 1px solid var(--iu-hairline);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  white-space: pre-wrap;
}
@container (max-width: 560px) {
  .git-history__grid {
    grid-template-columns: 1fr;
    grid-template-rows: 40% 1fr;
  }
  .git-history__list {
    border-right: 0;
    border-bottom: 1px solid var(--iu-hairline);
  }
}
</style>
