<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  parseProjectSources,
  type ClaudeCodeTrackingStatus,
  type ProjectOrigin,
} from '@odin/shared/api'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField, IuSwitch, IuTextarea } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuDialog } from '@/components/Modal'
import { IuPropertyList } from '@/components/PropertyList'
import { useToast } from '@/components/Toast'
import FormSection from '@/screens/shared/FormSection.vue'
import SyncBadge from '@/screens/shared/SyncBadge.vue'
import { relativeTime, shortHash } from '@/screens/shared/format'
import { useProject } from '../useProject'
import {
  formFromProject,
  RESET_REQUEST,
  settingsChanges,
  validateSettings,
  type SettingsForm,
} from './settingsForm'

const api = useApi()
const router = useRouter()
const store = useProjects()
const { toast } = useToast()
const { detail, setDetail } = useProject()

const name = computed(() => detail.value.name)

// ── settings form ───────────────────────────────────────────────────────────
const saved = computed(() => formFromProject(detail.value))
const form = reactive<SettingsForm>({ ...saved.value })

// A change that arrives from outside (another save, PROJECT.md edited) updates the fields the user hasn't touched.
watch(saved, (next, prev) => {
  for (const key of Object.keys(next) as (keyof SettingsForm)[]) {
    if (form[key] === prev[key]) form[key] = next[key]
  }
})

const attempted = ref(false)
const allErrors = computed(() => validateSettings(form))
// An error shows once the user has changed that field, or tried to save.
const errors = computed(() =>
  Object.fromEntries(
    Object.entries(allErrors.value).filter(
      ([key]) =>
        attempted.value ||
        form[key as keyof SettingsForm] !== saved.value[key as keyof SettingsForm],
    ),
  ),
)
const changes = computed(() => settingsChanges(form, detail.value))
const saving = ref(false)
const saveError = ref<string | null>(null)

async function save() {
  attempted.value = true
  if (Object.keys(allErrors.value).length) return
  const req = changes.value
  if (!req) return
  saving.value = true
  saveError.value = null
  try {
    setDetail(await api.updateProjectSettings(name.value, req))
    attempted.value = false
    toast({ title: 'Settings saved', intent: 'success' })
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function discard() {
  Object.assign(form, saved.value)
  attempted.value = false
  saveError.value = null
}

function originText(origin: ProjectOrigin | undefined): string {
  if (!origin) return ''
  if (origin.kind === 'default') return 'Default'
  if (origin.kind === 'override') return 'Saved in Odin'
  if (origin.kind === 'manifest') return 'From PROJECT.md'
  if (origin.kind === 'document') return `From ${origin.path}`
  if (origin.kind === 'package') return 'From package.json'
  if (origin.kind === 'git') return 'From the git remote'
  return 'Default'
}
const provenance = computed(() => detail.value.context.provenance)
const discovered = computed(() => detail.value.context.discovered)
const sourceForm = reactive({
  overview: detail.value.context.sources.overview ?? '',
  status: detail.value.context.sources.status.join('\n'),
  planning: detail.value.context.sources.planning.join('\n'),
})
watch(
  () => detail.value.updatedAt,
  () => {
    sourceForm.overview = detail.value.context.sources.overview ?? ''
    sourceForm.status = detail.value.context.sources.status.join('\n')
    sourceForm.planning = detail.value.context.sources.planning.join('\n')
  },
)
const savingSources = ref(false)
const sourceError = ref<string | null>(null)

function sourceSelection() {
  return {
    overview: sourceForm.overview.trim() || null,
    status: sourceForm.status
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
    planning: sourceForm.planning
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  }
}

async function saveSources() {
  const parsed = parseProjectSources(sourceSelection())
  if (!parsed.ok) {
    sourceError.value = parsed.error
    return
  }
  savingSources.value = true
  sourceError.value = null
  try {
    setDetail(await api.updateProjectSources(name.value, parsed.selection))
    toast({ title: 'Sources saved', intent: 'success' })
  } catch (e) {
    sourceError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingSources.value = false
  }
}

async function useDiscoveredSources() {
  savingSources.value = true
  sourceError.value = null
  try {
    setDetail(await api.updateProjectSources(name.value, null))
    toast({ title: 'Using discovered sources', intent: 'success' })
  } catch (e) {
    sourceError.value = e instanceof Error ? e.message : String(e)
  } finally {
    savingSources.value = false
  }
}

const resetting = ref(false)
async function resetToManifest() {
  resetting.value = true
  saveError.value = null
  try {
    const next = await api.updateProjectSettings(name.value, RESET_REQUEST)
    setDetail(next)
    Object.assign(form, formFromProject(next))
    attempted.value = false
    toast({ title: 'Back to PROJECT.md', intent: 'success' })
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  } finally {
    resetting.value = false
  }
}

// ── git state ───────────────────────────────────────────────────────────────
const gitItems = computed(() => {
  const g = detail.value.git
  return [
    { label: 'Branch', value: g.branch ?? 'detached', mono: true },
    { label: 'Commit', value: g.headSha ? shortHash(g.headSha) : 'none yet', mono: true },
    {
      label: 'Working tree',
      value: g.dirty ? 'Has uncommitted changes' : 'Clean',
    },
    ...(g.ahead || g.behind
      ? [{ label: 'Upstream', value: `${g.ahead} ahead, ${g.behind} behind` }]
      : []),
  ]
})

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
  <div class="project-settings">
    <IuCallout
      v-if="detail.manifestError"
      intent="warning"
      title="PROJECT.md has problems"
      class="project-settings__notice"
    >
      {{ detail.manifestError }} Defaults are used where a field was invalid.
    </IuCallout>

    <IuCallout
      v-if="detail.dirtyFiles.length"
      intent="info"
      title="Odin changed these files; commit them when ready"
      class="project-settings__notice"
    >
      <ul class="project-settings__files">
        <li v-for="f in detail.dirtyFiles" :key="f">{{ f }}</li>
      </ul>
    </IuCallout>

    <form class="project-settings__form" novalidate @submit.prevent="save">
      <FormSection
        title="Project"
        description="Saved in Odin. Your values win over PROJECT.md, then the selected overview, package scripts and git remote."
      >
        <div class="form-grid">
          <IuField
            v-model="form.title"
            label="Title"
            :error="errors.title"
            :hint="errors.title ? undefined : originText(provenance.title)"
            class="form-span"
          />
          <IuTextarea
            v-model="form.description"
            label="Description"
            :rows="2"
            :hint="originText(provenance.description)"
            class="form-span"
          />
          <IuField
            v-model="form.repo"
            label="GitHub repo"
            placeholder="owner/name"
            mono
            :error="errors.repo"
            :hint="
              errors.repo
                ? undefined
                : `${originText(provenance.repo)}. Leave empty for a local-only project.`
            "
          />
          <IuField
            v-model="form.defaultBranch"
            label="Default branch"
            mono
            :error="errors.defaultBranch"
          />
        </div>
      </FormSection>

      <FormSection title="Commands" description="Run in the project or a session's worktree.">
        <div class="form-grid">
          <IuField
            v-model="form.install"
            label="Install"
            mono
            placeholder="npm ci"
            :hint="originText(provenance.commands.install)"
          />
          <IuField
            v-model="form.check"
            label="Check"
            mono
            placeholder="npm run typecheck && npm test"
            :hint="originText(provenance.commands.check)"
          />
          <IuField
            v-model="form.build"
            label="Build"
            mono
            placeholder="npm run build"
            :hint="originText(provenance.commands.build)"
          />
        </div>
      </FormSection>

      <FormSection
        title="Sources"
        description="Overview, status and planning files stay in the repo. Odin only remembers which ones you picked."
      >
        <IuCallout
          v-if="detail.context.missing.length"
          intent="warning"
          title="Some saved sources are missing"
          class="project-settings__notice"
        >
          {{ detail.context.missing.join(', ') }}
        </IuCallout>
        <div class="form-grid">
          <IuField
            v-model="sourceForm.overview"
            label="Overview document"
            mono
            class="form-span"
            :hint="`Discovered: ${discovered.overview ?? 'none'}`"
          />
          <IuTextarea
            v-model="sourceForm.status"
            label="Status documents"
            :rows="3"
            mono
            class="form-span"
            :hint="`One path per line. Discovered: ${discovered.status.join(', ') || 'none'}`"
          />
          <IuTextarea
            v-model="sourceForm.planning"
            label="Planning folders"
            :rows="3"
            mono
            class="form-span"
            :hint="`One path per line. Discovered: ${discovered.planning.join(', ') || 'none'}`"
          />
        </div>
        <p v-if="sourceError" class="project-settings__state" role="status">{{ sourceError }}</p>
        <div class="project-settings__actions">
          <IuButton
            type="button"
            variant="ghost"
            :loading="savingSources"
            @click="useDiscoveredSources"
          >
            Use discovered sources
          </IuButton>
          <IuButton type="button" variant="primary" :loading="savingSources" @click="saveSources">
            Save sources
          </IuButton>
        </div>
      </FormSection>

      <div class="project-settings__actions" :data-dirty="changes ? '' : undefined">
        <p class="project-settings__state" role="status">
          <template v-if="saveError"><IuIcon name="alert" :size="14" /> {{ saveError }}</template>
          <template v-else-if="changes">Unsaved changes</template>
          <template v-else>All changes saved</template>
        </p>
        <IuButton type="button" variant="ghost" :loading="resetting" @click="resetToManifest">
          Reset to PROJECT.md
        </IuButton>
        <IuButton type="button" variant="ghost" :disabled="!changes || saving" @click="discard">
          Discard
        </IuButton>
        <IuButton type="submit" variant="primary" :loading="saving" :disabled="!changes">
          Save changes
        </IuButton>
      </div>
    </form>

    <FormSection title="Git" description="Read from the checkout.">
      <IuPropertyList :items="gitItems" label-width="120px" density="compact" />
    </FormSection>

    <FormSection title="GitHub sync" description="Optional: links sessions to their pull requests.">
      <template #aside><SyncBadge :sync="sync" /></template>
      <IuSwitch
        :model-value="detail.settings.githubEnabled ?? false"
        :disabled="syncBusy"
        label="Enable GitHub integration"
        @update:model-value="setGithub"
      />
      <div class="project-settings__row">
        <p class="project-settings__meta">
          <template v-if="!detail.repo">Add a GitHub repo above to sync this project.</template>
          <template v-else-if="sync.state === 'error' && sync.error">{{ sync.error }}</template>
          <template v-else-if="sync.lastSyncAt"
            >Last synced {{ relativeTime(sync.lastSyncAt) }}.</template
          >
          <template v-else>Not synced yet.</template>
        </p>
        <IuButton
          :disabled="!detail.settings.githubEnabled || !detail.repo || syncing"
          :loading="syncing"
          @click="syncNow"
        >
          <template #icon><IuIcon name="retry" :size="14" /></template>
          Sync now
        </IuButton>
      </div>
    </FormSection>

    <FormSection
      title="Claude Code tracking"
      description="Hooks that report Claude Code sessions you run in this repo's terminal."
    >
      <div class="project-settings__row">
        <p class="project-settings__meta">
          Installed in
          <code class="project-settings__code">{{
            tracking?.settingsPath ?? '.claude/settings.local.json'
          }}</code
          >, which isn't committed.
        </p>
        <IuSwitch
          :model-value="tracking?.enabled ?? false"
          :disabled="!tracking || trackingBusy"
          label="Track sessions"
          @update:model-value="setTracking"
        />
      </div>
      <IuCallout v-if="trackingError" intent="danger" variant="inline" live>{{
        trackingError
      }}</IuCallout>
    </FormSection>

    <FormSection
      title="Remove project"
      description="Forgets the project in Odin. The folder, its worktrees and Claude's own history stay."
    >
      <div>
        <IuButton variant="danger" @click="confirmRemove = true">Remove project…</IuButton>
      </div>
    </FormSection>

    <IuDialog v-model:open="confirmRemove" size="sm">
      <template #header>
        <h2 class="project-settings__dialog-title">Remove {{ detail.title }}?</h2>
      </template>
      <p class="project-settings__meta">
        Odin stops tracking this project. Projects configured in sessions must be kept until those
        sessions are removed. Nothing on disk is deleted.
      </p>
      <template #footer>
        <IuButton variant="ghost" @click="confirmRemove = false">Cancel</IuButton>
        <IuButton variant="danger" :loading="removing" @click="remove">Remove</IuButton>
      </template>
    </IuDialog>
  </div>
</template>

<style>
.project-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 800px;
  padding-top: 16px;
}
.project-settings__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.project-settings__files {
  margin: 0;
  padding-left: 18px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.project-settings__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.project-settings__meta {
  margin: 0;
  min-width: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.project-settings__code {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.project-settings__dialog-title {
  margin: 0;
  font-size: var(--iu-font-size-16);
  font-weight: var(--iu-font-weight-semibold);
}
.project-settings__actions {
  position: sticky;
  bottom: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 0;
  background: var(--iu-ground);
  border-top: 1px solid var(--iu-hairline);
}
.project-settings__state {
  flex: 1;
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.project-settings__actions[data-dirty] .project-settings__state {
  color: var(--iu-text);
}
@media (max-width: 640px) {
  .project-settings__row {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
