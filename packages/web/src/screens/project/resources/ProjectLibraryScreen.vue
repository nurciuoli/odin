<script setup lang="ts">
// The library assets installed in this project, each with its drift state and what can be done about it.
import { computed, ref, shallowRef, watch } from 'vue'
import type { AssetKind, Installation, LibraryAsset } from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuIcon } from '@/components/Icon'
import { IuDialog } from '@/components/Modal'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { useToast } from '@/components/Toast'
import { plural, relativeTime, shortHash } from '@/screens/shared/format'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import { useProject } from '../useProject'
import AssetDiffModal from './AssetDiffModal.vue'
import InstallFromLibraryModal from './InstallFromLibraryModal.vue'
import {
  DRIFT_DISPLAY,
  driftActions,
  installKey,
  type DriftAction,
  type DriftActionDef,
} from './driftModel'

const KIND_LABEL: Record<AssetKind, string> = {
  instruction: 'AGENTS.md',
  agent: 'Agent',
  skill: 'Skill',
  command: 'Command',
  prompt: 'Prompt',
  template: 'Template',
  mcp: 'MCP server',
  settings: 'Settings profile',
}

const api = useApi()
const { toast } = useToast()
const { detail } = useProject()
const name = computed(() => detail.value.name)

interface Loaded {
  installs: Installation[]
  assets: LibraryAsset[]
}
const res = useResource<Loaded>(async () => {
  const [installs, assets] = await Promise.all([
    api.listInstallations(name.value),
    // names are a nicety: without them the id is shown
    api.listLibrary().catch((): LibraryAsset[] => []),
  ])
  return { installs, assets }
})
watch(name, () => (res.reset(), void res.load()), { immediate: true })

function onEvent(e: ServerEvent) {
  const d = res.data.value
  if (!d) return
  if (e.type === 'install.updated' && e.installation.project === name.value) {
    const next = e.installation
    const has = d.installs.some(i => installKey(i) === installKey(next))
    res.data.value = {
      ...d,
      installs: has
        ? d.installs.map(i => (installKey(i) === installKey(next) ? next : i))
        : [...d.installs, next],
    }
  } else if (e.type === 'library.updated') void res.load()
}
useServerEvents(onEvent, () => void res.load())

const rows = computed(() => {
  const d = res.data.value
  if (!d) return []
  return d.installs
    .map(i => {
      const asset = d.assets.find(a => a.kind === i.kind && a.id === i.id)
      return { i, name: asset?.name ?? i.id, description: asset?.description ?? '' }
    })
    .sort((a, b) => a.i.kind.localeCompare(b.i.kind) || a.name.localeCompare(b.name))
})
const attention = computed(() => rows.value.filter(r => r.i.state !== 'current').length)

// ── actions ─────────────────────────────────────────────────────────────────
const busy = ref<string | null>(null)
const confirming = shallowRef<{ i: Installation; name: string; action: DriftActionDef } | null>(
  null,
)
const confirmOpen = computed({
  get: () => confirming.value !== null,
  set: v => {
    if (!v) confirming.value = null
  },
})
const diffFor = shallowRef<{ i: Installation; name: string } | null>(null)
const diffOpen = computed({
  get: () => diffFor.value !== null,
  set: v => {
    if (!v) diffFor.value = null
  },
})
const installOpen = ref(false)

const DONE: Record<DriftAction, string> = {
  update: 'Updated from the library',
  overwrite: 'Reset to the library version',
  push: 'Pushed to the library as a new version',
  forget: 'No longer tracked',
  diff: '',
}

async function run(i: Installation, label: string, action: DriftAction) {
  const key = installKey(i)
  busy.value = key
  try {
    const result = await api.install(name.value, {
      kind: i.kind,
      id: i.id,
      action: action === 'overwrite' ? 'update' : (action as 'update' | 'push' | 'forget'),
      force: action === 'overwrite' ? true : undefined,
    })
    const d = res.data.value
    if (d) {
      res.data.value = {
        ...d,
        installs: result.installation
          ? d.installs.map(x => (installKey(x) === key ? result.installation! : x))
          : d.installs.filter(x => installKey(x) !== key),
      }
    }
    toast({
      title: DONE[action],
      description: result.changed.length
        ? `${label}: ${plural(result.changed.length, 'file')} changed. Nothing is committed.`
        : label,
      intent: 'success',
    })
    // a push moves the library too
    if (action === 'push') void res.load()
  } catch (e) {
    toast({
      title: "Couldn't do that",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    busy.value = null
  }
}

function choose(i: Installation, assetName: string, action: DriftActionDef) {
  if (action.id === 'diff') diffFor.value = { i, name: assetName }
  else if (action.confirm) confirming.value = { i, name: assetName, action }
  else void run(i, assetName, action.id)
}

async function confirmAction() {
  const c = confirming.value
  if (!c) return
  confirming.value = null
  await run(c.i, c.name, c.action.id)
}

const confirmText = (id: DriftAction) =>
  id === 'push'
    ? 'This saves the project files as a new library version. Other projects that installed it will see an update.'
    : 'This replaces the project files with the library version. Your changes in the project are lost.'
</script>

<template>
  <div class="project-library">
    <div class="project-library__bar">
      <p class="project-library__note">
        Library assets copied into this project. Odin writes the files and never commits them.
      </p>
      <IuButton variant="primary" size="sm" @click="installOpen = true">
        <template #icon><IuIcon name="plus" :size="14" /></template>
        Install from library…
      </IuButton>
    </div>

    <IuSkeleton v-if="res.phase.value === 'loading'" shape="card" :rows="3" />

    <IuErrorState
      v-else-if="res.phase.value === 'error'"
      title="Couldn't load the installed assets"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`project.library.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />

    <IuEmpty
      v-else-if="!rows.length"
      title="Nothing installed from the library"
      body="Install instructions, a skill, subagent, MCP server or settings profile to use it in this project."
    >
      <template #action>
        <IuButton variant="secondary" size="sm" @click="installOpen = true">
          Install from library…
        </IuButton>
      </template>
    </IuEmpty>

    <template v-else>
      <IuCallout v-if="attention" intent="warning" variant="inline" live>
        {{ plural(attention, 'installed asset') }}
        {{ attention === 1 ? 'needs' : 'need' }} a look.
      </IuCallout>
      <ul class="project-library__list" aria-label="Installed assets">
        <li v-for="r in rows" :key="installKey(r.i)" class="project-library__row">
          <div class="project-library__head">
            <span class="project-library__name">{{ r.name }}</span>
            <IuBadge variant="tag" size="xs">{{ KIND_LABEL[r.i.kind] }}</IuBadge>
            <IuBadge :intent="DRIFT_DISPLAY[r.i.state].intent" dot>{{
              DRIFT_DISPLAY[r.i.state].label
            }}</IuBadge>
          </div>
          <p class="project-library__text">{{ DRIFT_DISPLAY[r.i.state].text }}</p>
          <p class="project-library__meta">
            Installed {{ shortHash(r.i.installedVersion) }} · library
            {{ r.i.libraryVersion ? shortHash(r.i.libraryVersion) : 'gone' }} · project
            {{ r.i.projectVersion ? shortHash(r.i.projectVersion) : 'missing' }} ·
            {{ relativeTime(r.i.installedAt) }} ·
            <code>{{ r.i.paths.join(', ') }}</code>
          </p>
          <div class="project-library__actions">
            <IuButton
              v-for="a in driftActions(r.i.state)"
              :key="a.id"
              :variant="a.id === 'update' ? 'primary' : 'secondary'"
              size="sm"
              :loading="busy === installKey(r.i) && a.id !== 'diff'"
              :disabled="busy === installKey(r.i)"
              @click="choose(r.i, r.name, a)"
            >
              {{ a.label }}
            </IuButton>
          </div>
        </li>
      </ul>
    </template>

    <AssetDiffModal
      v-model:open="diffOpen"
      :installation="diffFor?.i ?? null"
      :name="diffFor?.name ?? ''"
    />
    <InstallFromLibraryModal
      v-model:open="installOpen"
      :project="name"
      :installed="(res.data.value?.installs ?? []).map(installKey)"
      @installed="res.load()"
    />

    <IuDialog v-model:open="confirmOpen" size="sm">
      <template #header>
        <h2 class="project-library__title">{{ confirming?.action.label }}?</h2>
      </template>
      <p v-if="confirming" class="project-library__text">
        {{ confirming.name }}: {{ confirmText(confirming.action.id) }}
      </p>
      <template #footer>
        <IuButton variant="ghost" size="sm" @click="confirmOpen = false">Cancel</IuButton>
        <IuButton variant="danger" size="sm" @click="confirmAction">{{
          confirming?.action.label
        }}</IuButton>
      </template>
    </IuDialog>
  </div>
</template>

<style>
.project-library {
  padding-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.project-library__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.project-library__note {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.project-library__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.project-library__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.project-library__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-raised);
}
.project-library__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.project-library__name {
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.project-library__text {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.project-library__meta {
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  overflow-wrap: anywhere;
}
.project-library__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
</style>
