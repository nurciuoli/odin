<script setup lang="ts">
// A file with who last changed each line beside it. A run of lines from one commit shows its author (or the Odin
// session that made it, with the turn) once. Hovering the gutter shows the commit; clicking it opens that commit in
// the file's history. The aside sums up who wrote the file: people, and sessions as one group.
import { computed, ref, watch } from 'vue'
import type { GitBlame, GitCommit, GitTarget } from '@odin/shared/git'
import { useApi } from '@/api'
import { IuHoverCard } from '@/components/HoverCard'
import { IuIcon } from '@/components/Icon'
import { relativeTime } from './useGit'
import { useSessionTitles } from './useSessionTitles'

const props = defineProps<{ target: GitTarget; path: string; source: string }>()
const emit = defineEmits<{ commit: [sha: string] }>()

const ZERO = '0000000000000000000000000000000000000000'
const api = useApi()
const blame = ref<GitBlame | null>(null)
const error = ref<string | null>(null)
const titles = useSessionTitles()

watch(
  () => [props.target.kind, props.target.id, props.path, props.source] as const,
  async () => {
    error.value = null
    try {
      blame.value = await api.gitBlame(props.target, props.path)
      for (const c of Object.values(blame.value.commits)) if (c.sessionId) titles.want(c.sessionId)
    } catch (e) {
      blame.value = null
      error.value = e instanceof Error ? e.message : String(e)
    }
  },
  { immediate: true },
)

interface Row {
  n: number
  text: string
  sha: string | null
  first: boolean
}
const lines = computed(() => props.source.replace(/\n$/, '').split('\n'))
const rows = computed<Row[]>(() => {
  const owner = new Map<number, string>()
  for (const r of blame.value?.ranges ?? [])
    for (let i = 0; i < r.lines; i++) owner.set(r.start + i, r.sha)
  let prev: string | null | undefined
  return lines.value.map((text, i) => {
    const sha = owner.get(i + 1) ?? null
    const row = { n: i + 1, text, sha, first: sha !== prev }
    prev = sha
    return row
  })
})
const commitOf = (sha: string | null): GitCommit | null =>
  (sha && blame.value?.commits[sha]) || null
const HOUR = 3_600_000
function who(sha: string | null): string {
  if (!sha || sha === ZERO) return 'Not committed yet'
  const c = commitOf(sha)
  if (!c) return sha.slice(0, 7)
  if (c.sessionId)
    return `${titles.title(c.sessionId) ?? 'Odin session'}${c.turns ? ` · T${c.turns}` : ''}`
  return `${c.author} · ${c.subject.replace(/^\w+(\([^)]*\))?!?:\s*/, '')}`
}
const recent = (sha: string | null) => {
  const c = commitOf(sha)
  return !!c && Date.now() - Date.parse(c.at) < 24 * HOUR
}

const share = computed(() => {
  const counts = new Map<string, number>()
  let total = 0
  for (const r of rows.value) {
    const c = commitOf(r.sha)
    const key = !r.sha || r.sha === ZERO ? 'Not committed' : c?.sessionId ? 'sessions' : c?.author
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
    total++
  }
  const sessions = new Set(
    Object.values(blame.value?.commits ?? {})
      .map(c => c.sessionId)
      .filter(Boolean),
  ).size
  return [...counts]
    .map(([key, n]) => ({
      key,
      label: key === 'sessions' ? `Odin sessions (${sessions})` : key,
      session: key === 'sessions',
      pct: Math.round((n / Math.max(total, 1)) * 100),
    }))
    .sort((a, b) => b.pct - a.pct)
})
</script>

<template>
  <div class="git-blame">
    <p v-if="error" class="git-blame__note">Can't show blame: {{ error }}</p>
    <template v-else>
      <div class="git-blame__code" role="table" :aria-label="`Blame for ${path}`">
        <div
          v-for="r in rows"
          :key="r.n"
          class="git-blame__row"
          :class="{ 'git-blame__row--start': r.first && r.n > 1 }"
          role="row"
        >
          <span
            class="git-blame__who"
            :class="{
              'git-blame__who--session': !!commitOf(r.sha)?.sessionId,
              'git-blame__who--recent': recent(r.sha),
            }"
            role="cell"
          >
            <IuHoverCard
              v-if="r.first && commitOf(r.sha)"
              :label="`Commit ${commitOf(r.sha)!.shortSha}`"
              :width="360"
            >
              <button type="button" class="git-blame__who-button" @click="emit('commit', r.sha!)">
                <IuIcon :name="commitOf(r.sha)!.sessionId ? 'terminal' : 'user'" :size="14" />
                <span class="git-blame__who-text">{{ who(r.sha) }}</span>
                <span class="git-blame__age">{{ relativeTime(commitOf(r.sha)!.at) }}</span>
              </button>
              <template #card>
                <div class="git-blame__card">
                  <div class="git-blame__card-subject">{{ commitOf(r.sha)!.subject }}</div>
                  <div v-if="commitOf(r.sha)!.sessionId" class="git-blame__card-line">
                    Session {{ titles.title(commitOf(r.sha)!.sessionId!) ?? '' }}
                    <template v-if="commitOf(r.sha)!.turns">
                      · turn {{ commitOf(r.sha)!.turns }}</template
                    >
                  </div>
                  <div class="git-blame__card-meta">
                    {{ commitOf(r.sha)!.shortSha }} · {{ relativeTime(commitOf(r.sha)!.at) }} ·
                    {{ commitOf(r.sha)!.author }}
                  </div>
                  <p v-if="commitOf(r.sha)!.body" class="git-blame__card-body">
                    {{ commitOf(r.sha)!.body.split('\n\n')[0] }}
                  </p>
                  <div class="git-blame__card-hint">Click to open it in History</div>
                </div>
              </template>
            </IuHoverCard>
            <span v-else-if="r.first" class="git-blame__who-text git-blame__who-text--plain">{{
              who(r.sha)
            }}</span>
          </span>
          <span class="git-blame__n" role="cell">{{ r.n }}</span>
          <code class="git-blame__src" role="cell">{{ r.text }}</code>
        </div>
      </div>
      <aside v-if="share.length" class="git-blame__aside" aria-label="Who wrote this file">
        <h3 class="git-blame__aside-title">Who wrote this file</h3>
        <ul class="git-blame__share">
          <li v-for="s in share" :key="s.key" class="git-blame__share-row">
            <IuIcon :name="s.session ? 'terminal' : 'user'" :size="14" />
            <span class="git-blame__share-name">{{ s.label }}</span>
            <span class="git-blame__share-pct">{{ s.pct }}%</span>
            <span class="git-blame__bar" aria-hidden="true"
              ><span
                class="git-blame__bar-fill"
                :class="{ 'git-blame__bar-fill--session': s.session }"
                :style="{ width: `${s.pct}%` }"
            /></span>
          </li>
        </ul>
      </aside>
    </template>
  </div>
</template>

<style>
.git-blame {
  container-type: inline-size;
  display: flex;
  min-height: 100%;
  background: var(--iu-well);
}
.git-blame__note {
  margin: 0;
  padding: 16px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.git-blame__code {
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-code);
}
.git-blame__row {
  display: grid;
  grid-template-columns: minmax(120px, 210px) 40px 1fr;
  height: calc(var(--iu-font-size-12) * var(--iu-leading-code));
}
.git-blame__row--start .git-blame__who {
  border-top: 1px solid var(--iu-hairline);
}
.git-blame__who {
  min-width: 0;
  overflow: hidden;
  display: flex;
  align-items: center;
  background: var(--iu-gutter);
  border-right: 1px solid var(--iu-hairline);
}
.git-blame__who--session {
  box-shadow: inset 2px 0 var(--iu-accent-border);
}
.git-blame__who--recent {
  box-shadow: inset 2px 0 var(--iu-accent);
}
.git-blame__who > * {
  min-width: 0;
  flex: 1;
  height: 100%;
}
.git-blame__who-button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  height: 100%;
  padding: 0 10px;
  border: 0;
  background: transparent;
  font: inherit;
  line-height: var(--iu-leading-none);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  text-align: left;
  cursor: pointer;
}
.git-blame__who-button:hover {
  color: var(--iu-text);
}
.git-blame__who-button:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: -2px;
}
.git-blame__who-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-blame__who-text--plain {
  padding: 0 10px;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-disabled);
}
.git-blame__age {
  margin-left: auto;
  flex: none;
  color: var(--iu-text-disabled);
}
.git-blame__n {
  padding-right: 10px;
  text-align: right;
  color: var(--iu-text-disabled);
  user-select: none;
}
.git-blame__src {
  font: inherit;
  padding-left: 6px;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--iu-text-2);
}
.git-blame__card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--iu-font-size-12);
}
.git-blame__card-subject {
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.git-blame__card-line {
  color: var(--iu-text-2);
}
.git-blame__card-meta {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}
.git-blame__card-body {
  margin: 6px 0 0;
  color: var(--iu-text-2);
}
.git-blame__card-hint {
  margin-top: 6px;
  color: var(--iu-text-muted);
}
.git-blame__aside {
  flex: none;
  width: 240px;
  padding: 12px 14px;
  border-left: 1px solid var(--iu-hairline);
  background: var(--iu-ground);
  font-size: var(--iu-font-size-12);
}
.git-blame__aside-title {
  margin: 0 0 10px;
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-semibold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.git-blame__share {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.git-blame__share-row {
  display: grid;
  grid-template-columns: 16px 1fr auto;
  align-items: center;
  column-gap: 8px;
  row-gap: 4px;
  color: var(--iu-text-2);
}
.git-blame__share-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-blame__share-pct {
  font-family: var(--iu-font-mono);
  color: var(--iu-text-muted);
}
.git-blame__bar {
  grid-column: 2 / 4;
  height: 4px;
  border-radius: var(--iu-radius-pill);
  background: var(--iu-hairline);
  overflow: hidden;
}
.git-blame__bar-fill {
  display: block;
  height: 100%;
  background: var(--iu-info);
}
.git-blame__bar-fill--session {
  background: var(--iu-accent-fill);
}
@container (max-width: 820px) {
  .git-blame__aside {
    display: none;
  }
}
</style>
