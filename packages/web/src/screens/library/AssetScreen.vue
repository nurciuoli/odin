<script setup lang="ts">
// One library asset: its editor (per kind), its versions with diffs, and where it's installed. Saving writes a new
// version when the content changed.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { AssetDetail, AssetFiles, InstallResult } from '@odin/shared/api'
import { isInstallable } from '@odin/shared/library'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import { IuPageHeader } from '@/components/PageHeader'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { IuTabs } from '@/components/Tabs'
import { useToast } from '@/components/Toast'
import { plural, relativeTime, shortHash } from '@/screens/shared/format'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import {
  entryFile,
  isAssetKind,
  JSON_KINDS,
  KIND_INFO,
  parseJsonObject,
  specProblems,
  kindNoun,
} from './assetForm'
import ExportPluginModal from './ExportPluginModal.vue'
import InstallModal from './InstallModal.vue'
import InstallsPanel from './InstallsPanel.vue'
import JsonSpecEditor from './JsonSpecEditor.vue'
import MarkdownEditor from './MarkdownEditor.vue'
import PluginMembers from './PluginMembers.vue'
import SkillEditor from './SkillEditor.vue'
import VersionsPanel from './VersionsPanel.vue'

const props = defineProps<{ kind: string; id: string }>()

const api = useApi()
const router = useRouter()
const { toast } = useToast()

const validKind = computed(() => isAssetKind(props.kind))
const kind = computed(() => (isAssetKind(props.kind) ? props.kind : 'agent'))

const res = useResource<AssetDetail>(() => api.getAsset(kind.value, props.id))
const draft = ref<AssetFiles>({})
const tab = ref('edit')
let reloadToken = 0

async function reload(resetDraft = false) {
  const token = ++reloadToken
  const key = `${props.kind}/${props.id}`
  const before = res.data.value
  const wasDirty = !!before && JSON.stringify(before.files) !== JSON.stringify(draft.value)
  const draftBefore = JSON.stringify(draft.value)
  await res.load()
  if (token !== reloadToken || key !== `${props.kind}/${props.id}`) return
  const now = res.data.value
  if (!now || now === before) return
  // keep unsaved edits when something else (an install, a rescan) caused the reload
  if (
    resetDraft ||
    !before ||
    before.asset.id !== now.asset.id ||
    before.asset.kind !== now.asset.kind ||
    (!wasDirty && JSON.stringify(draft.value) === draftBefore)
  ) {
    draft.value = { ...now.files }
  }
}
watch(
  () => [props.kind, props.id],
  () => {
    reloadToken++
    res.reset()
    draft.value = {}
    tab.value = 'edit'
    if (validKind.value) void reload(true)
  },
  { immediate: true },
)
useServerEvents(
  e => {
    if (
      (e.type === 'library.updated' && e.kind === props.kind && e.id === props.id) ||
      (e.type === 'install.updated' &&
        e.installation.kind === props.kind &&
        e.installation.id === props.id)
    )
      void reload()
  },
  () => void reload(),
)

const detail = computed(() => res.data.value)
const markdownKind = computed(() => kind.value as 'agent' | 'instruction')
const entry = computed(() => {
  const keys = Object.keys(draft.value)
  const want = entryFile(kind.value, props.id)
  return keys.includes(want) ? want : (keys[0] ?? want)
})
const entryText = computed({
  get: () => draft.value[entry.value] ?? '',
  set: v => (draft.value = { ...draft.value, [entry.value]: v }),
})

const dirty = computed(() => {
  const base = res.data.value?.files
  if (!base) return false
  const a = Object.keys(base)
  const b = Object.keys(draft.value)
  return a.length !== b.length || a.some(k => base[k] !== draft.value[k])
})
const problems = computed(() => {
  if (!JSON_KINDS.includes(kind.value)) return []
  const parsed = parseJsonObject(entryText.value)
  return 'error' in parsed ? ['The JSON doesn’t parse.'] : specProblems(kind.value, parsed.value)
})

// ── actions ─────────────────────────────────────────────────────────────────
const saving = ref(false)
async function save() {
  if (!detail.value || saving.value || !dirty.value || problems.value.length) return
  saving.value = true
  const before = detail.value.asset.version
  const key = `${props.kind}/${props.id}`
  const sentDraft = JSON.stringify(draft.value)
  try {
    const saved = await api.saveAsset(kind.value, props.id, { ...draft.value })
    if (key !== `${props.kind}/${props.id}`) return
    await reload(JSON.stringify(draft.value) === sentDraft)
    toast({
      title:
        saved.version === before
          ? 'Saved. Nothing changed.'
          : `Saved as version ${shortHash(saved.version)}`,
      intent: 'success',
    })
  } catch (e) {
    toast({
      title: "Couldn't save",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    saving.value = false
  }
}
function revert() {
  if (detail.value) draft.value = { ...detail.value.files }
}

const installing = ref(false)
const exporting = ref(false)
function installed(result: InstallResult, project: string) {
  toast({
    title: `Installed in ${project}`,
    description: result.changed.length
      ? `Changed ${result.changed.join(', ')}. Nothing is committed.`
      : undefined,
    intent: 'success',
  })
  void reload()
}

const deleting = ref(false)
const removing = ref(false)
async function remove() {
  removing.value = true
  try {
    await api.deleteAsset(kind.value, props.id)
    deleting.value = false
    toast({ title: `Deleted ${props.id}`, intent: 'success' })
    void router.push({ path: '/library', query: { kind: kind.value } })
  } catch (e) {
    toast({
      title: "Couldn't delete",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    removing.value = false
  }
}

const tabs = computed(() => [
  { id: 'edit', label: 'Edit' },
  { id: 'versions', label: 'Versions', badge: detail.value?.versions.length ?? 0 },
  { id: 'installs', label: 'Installs', badge: detail.value?.installs.length ?? 0 },
])
</script>

<template>
  <div class="asset">
    <IuEmpty
      v-if="!validKind"
      title="Unknown kind"
      :body="`There's no library kind called “${kind}”.`"
    >
      <template #action>
        <IuButton as="router-link" to="/library" variant="secondary">Back to the library</IuButton>
      </template>
    </IuEmpty>

    <IuSkeleton v-else-if="res.phase.value === 'loading'" shape="card" />
    <IuErrorState
      v-else-if="res.phase.value === 'error' && res.error.value?.status === 404"
      title="Not in the library"
      :body="`There's no ${kindNoun(kind)} called “${id}”. It may have been deleted.`"
      :trace-id="`library.asset.404`"
      retry-label="Back to the library"
      @retry="router.push({ path: '/library', query: { kind } })"
    />
    <IuErrorState
      v-else-if="res.phase.value === 'error'"
      title="Couldn't load this asset"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`library.asset.${res.error.value?.status ?? 0}`"
      @retry="reload(true)"
    />

    <template v-else-if="detail">
      <IuPageHeader
        :title="detail.asset.name"
        :subtitle="detail.asset.description || undefined"
        :eyebrow="KIND_INFO[kind].label"
        icon="folder"
        wrap
      >
        <template #actions>
          <IuButton v-if="isInstallable(kind)" variant="secondary" @click="installing = true"
            >Install into…</IuButton
          >
          <IuButton v-if="kind === 'plugin'" variant="secondary" @click="exporting = true"
            >Export…</IuButton
          >
          <IuButton variant="ghost" @click="deleting = true">Delete</IuButton>
        </template>
      </IuPageHeader>

      <p class="asset__meta">
        <code>{{ kind }}/{{ id }}</code>
        <span
          >version <code>{{ shortHash(detail.asset.version) }}</code></span
        >
        <span>updated {{ relativeTime(detail.asset.updatedAt) }}</span>
        <span>{{ plural(detail.installs.length, 'install') }}</span>
        <IuBadge v-if="dirty" intent="warning" size="xs">Unsaved changes</IuBadge>
      </p>

      <IuCallout
        v-if="detail.asset.error"
        intent="danger"
        variant="inline"
        title="This asset has a problem"
      >
        {{ detail.asset.error }}
      </IuCallout>

      <IuCallout v-if="kind === 'instruction'" intent="info" variant="inline"
        >The instructions named <code>global</code> apply to every Odin session. Install other
        instructions into a project to add them to its AGENTS.md. Existing project text is
        preserved.</IuCallout
      >
      <IuCallout v-if="kind === 'agent'" intent="info" variant="inline"
        >Subagents are available for the default agent to delegate to after installation in a
        project.</IuCallout
      >
      <IuCallout v-if="kind === 'plugin'" intent="info" variant="inline"
        >A plugin installs its own files and the library assets it includes together. Installing
        shows every hook, command and MCP server it adds before anything is written.</IuCallout
      >
      <PluginMembers v-if="kind === 'plugin'" :detail="detail" />
      <IuTabs v-model="tab" :tabs="tabs" :lazy="false">
        <template #panel:edit>
          <form v-if="Object.keys(draft).length" class="asset__edit" @submit.prevent="save">
            <SkillEditor v-if="kind === 'skill'" v-model="draft" />
            <SkillEditor
              v-else-if="kind === 'plugin'"
              v-model="draft"
              entry="plugin.json"
              noun="plugin"
            />
            <JsonSpecEditor
              v-else-if="JSON_KINDS.includes(kind)"
              v-model="entryText"
              :kind="kind"
            />
            <MarkdownEditor v-else v-model="entryText" :kind="markdownKind" />
            <div class="asset__save">
              <IuButton
                type="submit"
                variant="primary"
                :loading="saving"
                :disabled="!dirty || problems.length > 0"
                >Save as new version</IuButton
              >
              <IuButton variant="ghost" :disabled="!dirty || saving" @click="revert"
                >Revert</IuButton
              >
              <span v-if="problems.length" class="asset__why">{{ problems[0] }}</span>
              <span v-else-if="!dirty" class="asset__why">No changes to save.</span>
            </div>
          </form>
        </template>
        <template #panel:versions>
          <VersionsPanel :detail="detail" />
        </template>
        <template #panel:installs>
          <InstallsPanel
            :detail="detail"
            :installable="isInstallable(kind)"
            @changed="reload()"
            @install="installing = true"
          />
        </template>
      </IuTabs>

      <InstallModal
        v-if="isInstallable(kind)"
        v-model:open="installing"
        :kind="kind"
        :id="id"
        :name="detail.asset.name"
        @installed="installed"
      />

      <ExportPluginModal
        v-if="kind === 'plugin'"
        v-model:open="exporting"
        :id="id"
        :name="detail.asset.name"
      />

      <IuDialog v-model:open="deleting" size="sm">
        <template #header>
          <h2 class="asset__dialog-title">Delete “{{ detail.asset.name }}”?</h2>
        </template>
        <p class="asset__dialog-body">
          It is removed from the library folder. Projects that installed it keep their copies, and
          sessions already started keep working.
        </p>
        <template #footer>
          <IuButton variant="secondary" size="sm" @click="deleting = false">Cancel</IuButton>
          <IuButton variant="danger" size="sm" :loading="removing" @click="remove">Delete</IuButton>
        </template>
      </IuDialog>
    </template>
  </div>
</template>

<style>
.asset {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 16px;
}
.asset__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 16px;
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.asset__edit {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-top: 16px;
  max-width: 880px;
}
.asset__save {
  display: flex;
  align-items: center;
  gap: 10px;
}
.asset__why {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.asset__dialog-title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.asset__dialog-body {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
</style>
