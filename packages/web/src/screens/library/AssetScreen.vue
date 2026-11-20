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
import { attachMcpOAuth, mcpUrlChanged } from './mcpDraft'
import VersionsPanel from './VersionsPanel.vue'
import { useMcpSignIn } from '@/screens/mcp/useMcpSignIn'

const props = defineProps<{ kind: string; id: string }>()

const api = useApi()
const router = useRouter()
const { toast } = useToast()
const signIn = useMcpSignIn()

const validKind = computed(() => isAssetKind(props.kind))
const kind = computed(() => (isAssetKind(props.kind) ? props.kind : 'agent'))
const libraryList = computed(() => ({ name: 'library' as const, query: { kind: kind.value } }))

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

const savedMcpOauth = computed(() => {
  if (kind.value !== 'mcp' || !detail.value) return false
  const text = detail.value.files[entryFile('mcp', props.id)] ?? ''
  const parsed = parseJsonObject(text)
  return !('error' in parsed) && !!parsed.value.oauth
})
const mcpConnected = computed(() => {
  const s = signIn.status.value[props.id]
  return typeof s === 'object' && s.state === 'connected'
})
/** A remote spec with no `oauth` yet, whose URL publishes OAuth metadata. */
const offerOauth = ref(false)
watch(
  () => [props.id, savedMcpOauth.value, detail.value?.files] as const,
  async () => {
    offerOauth.value = false
    if (kind.value !== 'mcp' || !detail.value) return
    if (savedMcpOauth.value) {
      void signIn.load([props.id])
      return
    }
    const text = detail.value.files[entryFile('mcp', props.id)] ?? ''
    const parsed = parseJsonObject(text)
    if ('error' in parsed) return
    const doc = parsed.value
    const headers = doc.headers
    const hasAuth =
      !!headers &&
      typeof headers === 'object' &&
      !Array.isArray(headers) &&
      Object.keys(headers).some(h => h.toLowerCase() === 'authorization')
    if ((doc.type !== 'http' && doc.type !== 'sse') || typeof doc.url !== 'string' || hasAuth) return
    const id = props.id
    try {
      const found = await api.detectMcpOAuth(doc.url)
      if (id === props.id) offerOauth.value = found.oauth
    } catch {
      if (id === props.id) offerOauth.value = false
    }
  },
  { immediate: true },
)

async function beginSignIn() {
  if (!detail.value) return
  const name = detail.value.asset.name
  try {
    if (!savedMcpOauth.value) {
      const prepared = await attachMcpOAuth({ ...draft.value }, props.id, url =>
        api.detectMcpOAuth(url),
      )
      if (!prepared.signIn) {
        toast({ title: `${name} does not use sign-in`, intent: 'info' })
        return
      }
      if (prepared.added) {
        await api.saveAsset(kind.value, props.id, prepared.files)
        await reload(true)
      }
    }
    await signIn.connect(props.id, name)
  } catch (e) {
    toast({
      title: `Couldn't start sign-in for ${name}`,
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  }
}

// ── actions ─────────────────────────────────────────────────────────────────
const saving = ref(false)
async function save() {
  if (!detail.value || saving.value || !dirty.value || problems.value.length) return
  saving.value = true
  const before = detail.value.asset.version
  const key = `${props.kind}/${props.id}`
  const savedFiles = detail.value.files
  let files = { ...draft.value }
  let prompt = false
  let warning: string | null = null
  if (kind.value === 'mcp') {
    const prepared = await attachMcpOAuth(files, props.id, url => api.detectMcpOAuth(url))
    files = prepared.files
    warning = prepared.warning
    prompt = prepared.signIn && (prepared.added || mcpUrlChanged(savedFiles, files, props.id))
  }
  const draftAtSend = JSON.stringify(draft.value)
  const sentDraft = JSON.stringify(files)
  try {
    const saved = await api.saveAsset(kind.value, props.id, files)
    if (key !== `${props.kind}/${props.id}`) return
    await reload(JSON.stringify(draft.value) === draftAtSend || JSON.stringify(draft.value) === sentDraft)
    toast({
      title: warning
        ? 'Saved, but sign-in could not be checked'
        : saved.version === before
          ? 'Saved. Nothing changed.'
          : `Saved as version ${shortHash(saved.version)}`,
      description: warning ?? undefined,
      intent: warning ? 'warning' : 'success',
    })
    if (prompt) {
      await signIn.load([props.id])
      const s = signIn.status.value[props.id]
      if (typeof s === 'object' && s.state === 'needs-sign-in')
        await signIn.connect(props.id, detail.value?.asset.name ?? props.id)
    }
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
        :subtitle="kind === 'mcp' ? undefined : detail.asset.description || undefined"
        :icon="kind === 'mcp' ? undefined : 'folder'"
        wrap
      >
        <template #eyebrow>
          <RouterLink class="asset__back" :to="libraryList">{{
            KIND_INFO[kind].plural
          }}</RouterLink>
        </template>
        <template #actions>
          <template v-if="kind === 'mcp' && (savedMcpOauth || offerOauth)">
            <IuButton
              size="sm"
              :variant="mcpConnected ? 'ghost' : 'primary'"
              :loading="signIn.signingIn.value?.id === id"
              @click="beginSignIn"
            >
              {{ mcpConnected ? 'Sign in again' : 'Sign in' }}
            </IuButton>
            <IuButton
              v-if="mcpConnected"
              size="sm"
              variant="ghost"
              @click="signIn.disconnect(id, detail.asset.name)"
              >Sign out</IuButton
            >
          </template>
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

      <IuCallout v-if="signIn.signingIn.value" intent="info" variant="inline" live>
        Finish signing in to {{ signIn.signingIn.value.name }} in the browser tab that opened.
        <a :href="signIn.signingIn.value.url" target="_blank" rel="noopener noreferrer"
          >Open the sign-in page</a
        >
        if it didn't.
      </IuCallout>

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
.asset__back {
  color: inherit;
  text-decoration: none;
}
.asset__back:hover {
  text-decoration: underline;
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
