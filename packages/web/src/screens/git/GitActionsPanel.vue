<script setup lang="ts">
// The Library's Git actions tab: every project's `.odin/git-actions/*.json`, what triggers each, how its last run
// went, and the picked one's definition and output, with Run now. Definitions are edited in the repo, not here.
import { computed, ref, watch } from 'vue'
import type { GitAction, GitActionTrigger } from '@odin/shared/git'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuSegmented } from '@/components/Segmented'
import { IuEmpty } from '@/components/States'
import { useToast } from '@/components/Toast'
import { relativeTime } from './useGit'

const emit = defineEmits<{ count: [n: number] }>()
const api = useApi()
const projects = useProjects()
const { toast } = useToast()

interface Row {
  key: string
  project: string
  projectTitle: string
  action: GitAction
}
const rows = ref<Row[]>([])
const loading = ref(true)
async function load() {
  loading.value = true
  const lists = await Promise.all(
    projects.projects.value.map(async p => {
      try {
        const actions = await api.gitActions({ kind: 'project', id: p.name })
        return actions.map(action => ({
          key: `${p.name}/${action.id}`,
          project: p.name,
          projectTitle: p.title,
          action,
        }))
      } catch {
        return [] as Row[]
      }
    }),
  )
  rows.value = lists.flat()
  loading.value = false
  emit('count', rows.value.length)
  if (!rows.value.some(r => r.key === picked.value)) picked.value = rows.value[0]?.key ?? null
}
watch(
  () => projects.projects.value.map(p => p.name).join(),
  () => void load(),
  { immediate: true },
)

const filter = ref<'all' | GitActionTrigger>('all')
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'pre-commit', label: 'Before commit' },
  { value: 'pre-push', label: 'Before push' },
  { value: 'manual', label: 'On demand' },
]
const shown = computed(() =>
  rows.value.filter(r => filter.value === 'all' || r.action.on === filter.value),
)
const picked = ref<string | null>(null)
const current = computed(() => rows.value.find(r => r.key === picked.value) ?? null)

const WHEN: Record<GitActionTrigger, string> = {
  'pre-commit': 'before commit',
  'pre-push': 'before push',
  manual: 'on demand',
}
const WHEN_LONG: Record<GitActionTrigger, string> = {
  'pre-commit': 'Before every commit made from Odin',
  'pre-push': 'Before every push made from Odin',
  manual: 'Only when you press Run',
}
function failureLine(a: GitAction): string {
  if (a.on === 'manual') return 'Shows the output'
  if (!a.blocking) return `Warns; the ${a.on === 'pre-push' ? 'push' : 'commit'} goes ahead`
  return a.on === 'pre-push' ? 'Stops the push' : 'Stops the commit and offers "Ask Claude to fix"'
}
function definition(a: GitAction): string {
  return JSON.stringify(
    {
      title: a.title,
      ...(a.description ? { description: a.description } : {}),
      on: a.on,
      run: a.run,
      blocking: a.blocking,
      timeoutSec: a.timeoutSec,
      ...(a.enabled ? {} : { enabled: false }),
    },
    null,
    2,
  )
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

const running = ref<string | null>(null)
async function runNow(r: Row) {
  running.value = r.key
  try {
    const run = await api.gitRunAction({ kind: 'project', id: r.project }, r.action.id)
    r.action = { ...r.action, lastRun: run }
    rows.value = [...rows.value]
    toast({
      title: run.ok ? `${r.action.title} passed` : `${r.action.title} failed`,
      intent: run.ok ? 'success' : 'danger',
    })
  } catch (e) {
    toast({ title: "Couldn't run it", description: String(e), intent: 'danger' })
  } finally {
    running.value = null
  }
}
</script>

<template>
  <div class="git-actions">
    <p class="git-actions__blurb">
      Commands your repos ask Odin to run before a commit or push, or on demand. They live in
      <code>.odin/git-actions/</code> in each repo, run without a shell, and only when you commit,
      push or press Run.
    </p>
    <div class="git-actions__bar">
      <IuSegmented v-model="filter" :options="FILTERS" label="Show actions that run" />
      <span class="git-actions__grow" />
      <IuButton size="sm" variant="ghost" :loading="loading" @click="load">Refresh</IuButton>
    </div>
    <IuEmpty
      v-if="!loading && !rows.length"
      :eyebrow="false"
      title="No git actions yet"
      body='Add a JSON file to .odin/git-actions/ in a repo, for example run-tests.json with { "title": "Run tests", "on": "pre-commit", "run": ["yarn", "test"] }.'
    />
    <div v-else class="git-actions__split">
      <ul class="git-actions__list" role="listbox" aria-label="Git actions">
        <li v-for="r in shown" :key="r.key" role="presentation">
          <button
            type="button"
            role="option"
            class="git-actions__row"
            :class="{ 'git-actions__row--on': picked === r.key }"
            :aria-selected="picked === r.key"
            @click="picked = r.key"
          >
            <span class="git-actions__icon"
              ><IuIcon
                :name="
                  r.action.on === 'manual'
                    ? 'play'
                    : r.action.on === 'pre-push'
                      ? 'arrowUp'
                      : 'gitCommit'
                "
                :size="14"
            /></span>
            <span class="git-actions__text">
              <span class="git-actions__title">{{ r.action.title }}</span>
              <span class="git-actions__desc">{{
                r.action.error ? r.action.error : r.action.description || r.action.run.join(' ')
              }}</span>
            </span>
            <span class="git-actions__when">
              {{ WHEN[r.action.on] }}<template v-if="!r.action.enabled"> · off</template>
            </span>
            <span class="git-actions__last">
              <template v-if="r.action.error"
                ><span class="git-actions__bad">invalid</span></template
              >
              <template v-else-if="r.action.lastRun">
                <span :class="r.action.lastRun.ok ? 'git-actions__good' : 'git-actions__bad'">{{
                  r.action.lastRun.ok ? '✓' : '✕ failed'
                }}</span>
                · {{ relativeTime(r.action.lastRun.at) }}
              </template>
              <template v-else>never run</template>
            </span>
            <span class="git-actions__project">{{ r.projectTitle }}</span>
          </button>
        </li>
      </ul>

      <aside v-if="current" class="git-actions__detail" :aria-label="current.action.title">
        <header class="git-actions__detail-head">
          <div class="git-actions__detail-titles">
            <h2 class="git-actions__detail-title">{{ current.action.title }}</h2>
            <code class="git-actions__file">{{ current.action.file }}</code>
          </div>
          <IuButton
            size="sm"
            variant="secondary"
            :loading="running === current.key"
            :disabled="!!current.action.error"
            @click="runNow(current)"
          >
            <template #icon><IuIcon name="play" :size="14" /></template>
            Run now
          </IuButton>
        </header>
        <p v-if="current.action.error" class="git-actions__error">{{ current.action.error }}</p>
        <dl class="git-actions__kv">
          <dt>When</dt>
          <dd>
            {{ WHEN_LONG[current.action.on]
            }}<template v-if="!current.action.enabled"> (turned off)</template>
          </dd>
          <dt>Runs</dt>
          <dd>
            <code>{{ current.action.run.join(' ') || '—' }}</code>
          </dd>
          <dt>On failure</dt>
          <dd>{{ failureLine(current.action) }}</dd>
          <dt>Timeout</dt>
          <dd>
            {{
              current.action.timeoutSec >= 60
                ? `${Math.round(current.action.timeoutSec / 60)} min`
                : `${current.action.timeoutSec}s`
            }}
          </dd>
          <dt>Project</dt>
          <dd>{{ current.projectTitle }}</dd>
        </dl>
        <h3 class="git-actions__label">Definition</h3>
        <pre class="git-actions__pre">{{ definition(current.action) }}</pre>
        <template v-if="current.action.lastRun">
          <h3 class="git-actions__label">
            Last run
            <span :class="current.action.lastRun.ok ? 'git-actions__good' : 'git-actions__bad'">{{
              current.action.lastRun.ok ? 'passed' : 'failed'
            }}</span>
            · {{ relativeTime(current.action.lastRun.at) }} ·
            {{ seconds(current.action.lastRun.durationMs) }}
          </h3>
          <pre class="git-actions__pre">
$ {{ current.action.lastRun.command.join(' ') }}
{{ current.action.lastRun.output }}</pre
          >
        </template>
      </aside>
    </div>
  </div>
</template>

<style>
.git-actions {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.git-actions__blurb {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.git-actions__blurb code,
.git-actions__kv code {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.git-actions__bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.git-actions__grow {
  flex: 1;
}
.git-actions__split {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 420px);
  gap: 16px;
  align-items: start;
}
.git-actions__list {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  overflow: hidden;
}
.git-actions__row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr) 110px 120px 90px;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 14px;
  border: 0;
  border-bottom: 1px solid var(--iu-hairline);
  background: transparent;
  font: inherit;
  text-align: left;
  color: var(--iu-text-2);
  cursor: pointer;
}
.git-actions__list li:last-child .git-actions__row {
  border-bottom: 0;
}
.git-actions__row:hover {
  background: var(--iu-hover);
}
.git-actions__row--on {
  background: var(--iu-accent-wash);
}
.git-actions__row:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: -2px;
}
.git-actions__icon {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: var(--iu-radius-md);
  border: 1px solid var(--iu-border);
  background: var(--iu-raised);
}
.git-actions__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.git-actions__title {
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.git-actions__desc {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-actions__when,
.git-actions__last,
.git-actions__project {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.git-actions__good {
  color: var(--iu-positive);
}
.git-actions__bad {
  color: var(--iu-danger);
}
.git-actions__detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  background: var(--iu-raised);
  min-width: 0;
}
.git-actions__detail-head {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.git-actions__detail-titles {
  flex: 1;
  min-width: 0;
}
.git-actions__detail-title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.git-actions__file {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
}
.git-actions__error {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-danger);
}
.git-actions__kv {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 6px 10px;
  margin: 0;
  font-size: var(--iu-font-size-12);
}
.git-actions__kv dt {
  color: var(--iu-text-muted);
}
.git-actions__kv dd {
  margin: 0;
  color: var(--iu-text-2);
  min-width: 0;
  overflow-wrap: anywhere;
}
.git-actions__label {
  margin: 4px 0 0;
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-2);
}
.git-actions__pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 240px;
  overflow: auto;
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-sm);
  background: var(--iu-well);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-code);
  color: var(--iu-text-2);
  white-space: pre;
}
@container (max-width: 900px) {
  .git-actions__split {
    grid-template-columns: 1fr;
  }
  .git-actions__row {
    grid-template-columns: 28px minmax(0, 1fr) 100px;
  }
  .git-actions__last,
  .git-actions__project {
    display: none;
  }
}
</style>
