<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  parseProjectSources,
  type ClaudeCodeTrackingStatus,
  type ProjectOrigin,
  type UpdateProjectSettingsRequest,
} from '@odin/shared/api'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuSwitch } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuDialog } from '@/components/Modal'
import { useToast } from '@/components/Toast'
import SyncBadge from '@/screens/shared/SyncBadge.vue'
import { relativeTime, shortHash } from '@/screens/shared/format'
import { useCopy } from '@/composables/useCopy'
import { useProject } from '../useProject'
import SettingRow from './SettingRow.vue'
import { RESET_REQUEST, validateSetting } from './settingsForm'

const api = useApi()
const router = useRouter()
const store = useProjects()
const { toast } = useToast()
const { detail, setDetail } = useProject()

const name = computed(() => detail.value.name)
const settings = computed(() => detail.value.settings)
const provenance = computed(() => detail.value.context.provenance)

function originText(origin: ProjectOrigin | undefined): string {
  if (!origin) return ''
  if (origin.kind === 'override') return 'Odin'
  if (origin.kind === 'manifest') return 'PROJECT.md'
  if (origin.kind === 'document') return origin.path
  if (origin.kind === 'package') return 'package.json'
  if (origin.kind === 'git') return 'git remote'
  return 'default'
}

// ── one field at a time: each row saves itself ──
async function patch(req: UpdateProjectSettingsRequest) {
  setDetail(await api.updateProjectSettings(name.value, req))
}
const saveTitle = (v: string) => patch({ title: v })
const saveDescription = (v: string) => patch({ description: v })
const saveRepo = (v: string) => patch({ repo: v || null })
const saveBranch = (v: string) => patch({ defaultBranch: v })
function saveCommand(key: 'install' | 'check' | 'build') {
  return (v: string) => {
    const next = { ...settings.value.commands, [key]: v }
    if (!v) delete next[key]
    return patch({ commands: next })
  }
}

// ── context sources ──
const sources = computed(() => detail.value.context.sources)
const discovered = computed(() => detail.value.context.discovered)
const lines = (v: string) =>
  v
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)
const sourcesAreDiscovered = computed(
  () => JSON.stringify(sources.value) === JSON.stringify(discovered.value),
)
async function saveSources(
  change: Partial<{ overview: string | null; status: string[]; planning: string[] }>,
) {
  const parsed = parseProjectSources({
    overview: sources.value.overview,
    status: sources.value.status,
    planning: sources.value.planning,
    ...change,
  })
  if (!parsed.ok) throw new Error(parsed.error)
  setDetail(await api.updateProjectSources(name.value, parsed.selection))
}
async function useDiscoveredSources() {
  try {
    setDetail(await api.updateProjectSources(name.value, null))
    toast({ title: 'Using discovered sources', intent: 'success' })
  } catch (e) {
    toast({
      title: "Couldn't reset sources",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  }
}
const sourceOrigin = computed(() => (sourcesAreDiscovered.value ? 'discovered' : 'chosen'))

const resetting = ref(false)
async function resetToManifest() {
  resetting.value = true
  try {
    setDetail(await api.updateProjectSettings(name.value, RESET_REQUEST))
    toast({ title: 'Back to PROJECT.md', intent: 'success' })
  } catch (e) {
    toast({
      title: "Couldn't reset",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    resetting.value = false
  }
}

// ── read-only facts ──
const git = computed(() => {
  const g = detail.value.git
  return [
    g.branch ?? 'detached',
    g.headSha ? shortHash(g.headSha) : 'no commits yet',
    g.dirty ? 'uncommitted changes' : 'clean',
    ...(g.ahead || g.behind ? [`${g.ahead} ahead, ${g.behind} behind`] : []),
  ].join(' · ')
})
const { copy, copied } = useCopy()

// ── Claude Code tracking ────────────────────────────────────────────────────
const tracking = ref<ClaudeCodeTrackingStatus | null>(null)
const trackingBusy = ref(false)
const trackingError = ref<string | null>(null)
async function loadTracking() {
  try {
    tracking.value = await api.getClaudeCodeTracking(name.value)
    trackingError.value = null
  } catch (e) {
    trackingError.value = e instanceof Error ? e.message : String(e)
  }
}
async function setTracking(enabled: boolean) {
  trackingBusy.value = true
  trackingError.value = null
  try {
    tracking.value = await api.setClaudeCodeTracking(name.value, enabled)
  } catch (e) {
    trackingError.value = e instanceof Error ? e.message : String(e)
  } finally {
    trackingBusy.value = false
  }
}
onMounted(() => void loadTracking())

// ── GitHub sync ─────────────────────────────────────────────────────────────
const sync = computed(
  () => store.projects.value.find(p => p.name === name.value)?.sync ?? detail.value.sync,
)
const syncBusy = ref(false)
const syncing = computed(() => syncBusy.value || sync.value.state === 'syncing')
async function setGithub(enabled: boolean) {
  syncBusy.value = true
  try {
    setDetail(await api.updateProjectSettings(name.value, { githubEnabled: enabled }))
    await store.reload()
  } catch (e) {
    toast({
      title: 'Could not update GitHub integration',
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    syncBusy.value = false
  }
}
async function syncNow() {
  syncBusy.value = true
  try {
    await api.syncProject(name.value)
  } catch (e) {
    toast({
      title: 'Sync failed',
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    syncBusy.value = false
  }
}

// ── remove ──────────────────────────────────────────────────────────────────
const confirmRemove = ref(false)
const removing = ref(false)
async function remove() {
  removing.value = true
  try {
    await api.removeProject(name.value)
    confirmRemove.value = false
    await store.reload()
    await router.push('/')
    toast({ title: `Removed ${detail.value.title}`, intent: 'success' })
  } catch (e) {
    confirmRemove.value = false
    toast({
      title: "Couldn't remove the project",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    removing.value = false
  }
}
</script>

<template>
  <div class="settings-sheet">
    <IuCallout
      v-if="detail.manifestError"
      intent="warning"
      title="PROJECT.md has problems"
      class="settings-sheet__notice"
    >
      {{ detail.manifestError }} Defaults are used where a field was invalid.
    </IuCallout>
    <IuCallout
      v-if="detail.dirtyFiles.length"
      intent="info"
      title="Odin changed these files; commit them when ready"
      class="settings-sheet__notice"
    >
      <ul class="settings-sheet__files">
        <li v-for="f in detail.dirtyFiles" :key="f">{{ f }}</li>
      </ul>
    </IuCallout>

    <p class="settings-sheet__hint">
      Click a value to edit it. Enter saves, Esc cancels. Your values win over PROJECT.md, then
      package scripts and the git remote.
    </p>

    <section aria-labelledby="sheet-project">
      <h2 id="sheet-project" class="settings-sheet__heading">Project</h2>
      <SettingRow
        label="Title"
        :value="settings.title"
        :origin="originText(provenance.title)"
        :validate="v => validateSetting('title', v)"
        :save="saveTitle"
      />
      <SettingRow
        label="Description"
        multiline
        :value="settings.description"
        placeholder="Not set. Click to add."
        :origin="originText(provenance.description)"
        :save="saveDescription"
      />
      <SettingRow label="Folder" mono readonly :value="detail.path">
        <template #side>
          <IuButton size="sm" variant="ghost" @click="copy(detail.path)">
            {{ copied ? 'Copied' : 'Copy' }}
          </IuButton>
        </template>
      </SettingRow>
      <SettingRow label="Git" readonly :value="git" origin="read from the checkout" />
      <SettingRow
        label="GitHub repo"
        mono
        :value="settings.repo ?? ''"
        placeholder="Local only. Click to add owner/name."
        :origin="originText(provenance.repo)"
        :validate="v => validateSetting('repo', v)"
        :save="saveRepo"
      />
      <SettingRow
        label="Default branch"
        mono
        :value="settings.defaultBranch"
        :validate="v => validateSetting('defaultBranch', v)"
        :save="saveBranch"
      />
    </section>

    <section aria-labelledby="sheet-commands">
      <h2 id="sheet-commands" class="settings-sheet__heading">Commands</h2>
      <SettingRow
        v-for="c in [
          ['install', 'Install', 'npm ci'],
          ['check', 'Check', 'npm run typecheck && npm test'],
          ['build', 'Build', 'npm run build'],
        ] as const"
        :key="c[0]"
        :label="c[1]"
        mono
        :value="settings.commands[c[0]] ?? ''"
        :placeholder="`Not set. Click to add, e.g. ${c[2]}`"
        :origin="originText(provenance.commands[c[0]])"
        :save="saveCommand(c[0])"
      />
    </section>

    <section aria-labelledby="sheet-context">
      <h2 id="sheet-context" class="settings-sheet__heading">
        Context Odin reads
        <IuButton
          v-if="!sourcesAreDiscovered"
          size="sm"
          variant="ghost"
          @click="useDiscoveredSources"
        >
          Use discovered
        </IuButton>
      </h2>
      <IuCallout
        v-if="detail.context.missing.length"
        intent="warning"
        title="Some saved sources are missing"
        class="settings-sheet__notice"
      >
        {{ detail.context.missing.join(', ') }}
      </IuCallout>
      <SettingRow
        label="Overview"
        mono
        :value="sources.overview ?? ''"
        placeholder="None found. Click to add a path."
        :origin="sourceOrigin"
        :save="v => saveSources({ overview: v || null })"
      />
      <SettingRow
        label="Status"
        mono
        :value="sources.status.join(', ')"
        placeholder="None found. Click to add paths, separated by commas."
        :origin="sourceOrigin"
        :save="v => saveSources({ status: lines(v) })"
      />
      <SettingRow
        label="Planning"
        mono
        :value="sources.planning.join(', ')"
        placeholder="None found. Click to add folders, separated by commas."
        :origin="sourceOrigin"
        :save="v => saveSources({ planning: lines(v) })"
      />
    </section>

    <section aria-labelledby="sheet-integrations">
      <h2 id="sheet-integrations" class="settings-sheet__heading">Integrations</h2>
      <div class="sheet-row">
        <span class="sheet-row__label">GitHub sync</span>
        <div class="settings-sheet__switch">
          <IuSwitch
            :model-value="detail.settings.githubEnabled ?? false"
            :disabled="syncBusy"
            size="sm"
            label="Enable GitHub integration"
            @update:model-value="setGithub"
          />
          <span class="settings-sheet__meta">
            <template v-if="!detail.repo">Add a GitHub repo above to sync.</template>
            <template v-else-if="sync.state === 'error' && sync.error">{{ sync.error }}</template>
            <template v-else-if="sync.lastSyncAt"
              >Synced {{ relativeTime(sync.lastSyncAt) }}.</template
            >
            <template v-else>Links sessions to their pull requests.</template>
          </span>
        </div>
        <div class="sheet-row__side">
          <SyncBadge :sync="sync" />
          <IuButton
            size="sm"
            variant="ghost"
            :disabled="!detail.settings.githubEnabled || !detail.repo || syncing"
            :loading="syncing"
            @click="syncNow"
          >
            <template #icon><IuIcon name="retry" :size="14" /></template>
            Sync now
          </IuButton>
        </div>
      </div>
      <div class="sheet-row">
        <span class="sheet-row__label">Claude Code</span>
        <div class="settings-sheet__switch">
          <IuSwitch
            :model-value="tracking?.enabled ?? false"
            :disabled="!tracking || trackingBusy"
            size="sm"
            label="Track sessions"
            @update:model-value="setTracking"
          />
          <span class="settings-sheet__meta">
            Hooks in
            <code class="settings-sheet__code">{{
              tracking?.settingsPath ?? '.claude/settings.local.json'
            }}</code
            >, not committed.
          </span>
        </div>
        <div class="sheet-row__side" />
      </div>
      <IuCallout v-if="trackingError" intent="danger" variant="inline" live>{{
        trackingError
      }}</IuCallout>
    </section>

    <footer class="settings-sheet__foot">
      <IuButton variant="ghost" size="sm" :loading="resetting" @click="resetToManifest">
        Reset to PROJECT.md
      </IuButton>
      <span class="settings-sheet__spacer" />
      <IuButton variant="danger" size="sm" @click="confirmRemove = true">Remove project…</IuButton>
    </footer>

    <IuDialog v-model:open="confirmRemove" size="sm">
      <template #header>
        <h2 class="settings-sheet__dialog-title">Remove {{ detail.title }}?</h2>
      </template>
      <p class="settings-sheet__meta">
        Odin forgets the project. The folder, its worktrees and Claude's own history stay; nothing
        on disk is deleted. Projects used by sessions must be kept until those sessions are removed.
      </p>
      <template #footer>
        <IuButton variant="ghost" @click="confirmRemove = false">Cancel</IuButton>
        <IuButton variant="danger" :loading="removing" @click="remove">Remove</IuButton>
      </template>
    </IuDialog>
  </div>
</template>

<style>
.settings-sheet {
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-width: 860px;
  padding: 16px 0;
}
.settings-sheet__hint,
.settings-sheet__meta {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.settings-sheet__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 0 0 4px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  font-weight: var(--iu-font-weight-medium);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.settings-sheet__files {
  margin: 0;
  padding-left: 18px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.settings-sheet__switch {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 30px;
}
.settings-sheet__code {
  font-family: var(--iu-font-mono);
}
.settings-sheet__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--iu-hairline);
}
.settings-sheet__spacer {
  flex: 1;
}
.settings-sheet__dialog-title {
  margin: 0;
  font-size: var(--iu-font-size-16);
  font-weight: var(--iu-font-weight-semibold);
}
</style>
