<script setup lang="ts">
// The library: reusable agents, skills, commands, prompts, templates, MCP servers and settings profiles. A kind list
// on the left, compact rows on the right (same shape as Settings). The kind lives in the URL (?kind=).
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AssetKind, LibraryAsset } from '@odin/shared/api'
import { isInstallable, LIBRARY_KINDS } from '@odin/shared/library'
import { ApiRequestError, useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuEyebrow } from '@/components/Eyebrow'
import { IuCheckbox, IuSwitch } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuMenu } from '@/components/Menu'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { useToast } from '@/components/Toast'
import { plural, relativeTime, shortHash } from '@/screens/shared/format'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import { assetDetail, isAssetKind, KIND_INFO, kindNoun } from './assetForm'
import { assetMenu, copyId, type RowAction } from './libraryActions'
import McpPanel from '@/screens/mcp/McpPanel.vue'
import GitActionsPanel from '@/screens/git/GitActionsPanel.vue'
import DeleteAssetDialog, { type Target } from './DeleteAssetDialog.vue'
import ExportPluginModal from './ExportPluginModal.vue'
import ImportPluginModal from './ImportPluginModal.vue'
import InstallModal from './InstallModal.vue'
import NewAssetModal from './NewAssetModal.vue'

const api = useApi()
const route = useRoute()
const router = useRouter()
const projects = useProjects()
const { toast } = useToast()

const kind = computed<AssetKind>({
  get: () => {
    const q = route.query.kind
    return typeof q === 'string' && isAssetKind(q) ? q : 'instruction'
  },
  set: k => {
    selected.value = new Set()
    void router.replace({ query: { ...route.query, kind: k } })
  },
})
const selected = ref(new Set<string | number>())
// Git actions aren't library assets (they live in each repo), but they get a kind here so they're found with the rest.
const GIT_TAB = 'git-actions'
const tab = computed<string>({
  get: () => (route.query.kind === GIT_TAB ? GIT_TAB : kind.value),
  set: t => {
    if (t === GIT_TAB) void router.replace({ query: { ...route.query, kind: GIT_TAB } })
    else kind.value = t as AssetKind
  },
})
const onGitTab = computed(() => tab.value === GIT_TAB)
const gitActionCount = ref<number | undefined>(undefined)

// ── data ────────────────────────────────────────────────────────────────────
const res = useResource<LibraryAsset[]>(() => api.listLibrary())
void res.load()
useServerEvents(
  e => {
    if (e.type === 'library.updated' || e.type === 'install.updated') {
      void res.load()
      void loadInstalls()
    }
  },
  () => void res.load(),
)

// How many projects each asset is installed in. Best effort: a project that fails just counts nothing.
const installs = ref<Record<string, number> | null>(null)
async function loadInstalls() {
  const counts: Record<string, number> = {}
  await Promise.all(
    projects.projects.value.map(async p => {
      try {
        for (const i of await api.listInstallations(p.name)) {
          const key = `${i.kind}/${i.id}`
          counts[key] = (counts[key] ?? 0) + 1
        }
      } catch {
        // ignore this project
      }
    }),
  )
  installs.value = counts
}
watch(
  () => projects.projects.value.length,
  () => void loadInstalls(),
  { immediate: true },
)

const all = computed(() => res.data.value ?? [])
const tabs = computed(() => [
  ...LIBRARY_KINDS.map(k => ({
    id: k as string,
    label: KIND_INFO[k].plural,
    badge: all.value.filter(a => a.kind === k).length as number | undefined,
  })),
  { id: GIT_TAB, label: 'Git actions', badge: gitActionCount.value },
])

type Row = {
  key: string
  id: string
  name: string
  description: string
  detail: string
  version: string
  updatedAt: string
  installs: number | null
  enabled: boolean
  actions: null
  error: string | null
}
const rows = computed<Row[]>(() =>
  all.value
    .filter(a => a.kind === kind.value)
    .map(a => ({
      key: `${a.kind}/${a.id}`,
      id: a.id,
      name: a.name,
      description: a.description,
      detail: assetDetail(a),
      version: shortHash(a.version),
      updatedAt: a.updatedAt,
      installs: installs.value ? (installs.value[`${a.kind}/${a.id}`] ?? 0) : null,
      enabled: a.enabled,
      actions: null,
      error: a.error,
    })),
)
const currentLabel = computed(() => (onGitTab.value ? 'Git actions' : KIND_INFO[kind.value].plural))
const installable = computed(() => !onGitTab.value && isInstallable(kind.value))
const allSelected = computed(
  () => rows.value.length > 0 && rows.value.every(r => selected.value.has(r.id)),
)
const someSelected = computed(
  () => rows.value.some(r => selected.value.has(r.id)) && !allSelected.value,
)
function toggleAll(on: boolean) {
  selected.value = on ? new Set(rows.value.map(r => r.id)) : new Set()
}
function toggleRow(id: string, on: boolean) {
  const next = new Set(selected.value)
  if (on) next.add(id)
  else next.delete(id)
  selected.value = next
}

const installTarget = ref<{ id: string; name: string } | null>(null)
const installing = computed({
  get: () => installTarget.value !== null,
  set: v => {
    if (!v) installTarget.value = null
  },
})
function installed(_r: unknown, project: string) {
  toast({ title: `Installed in ${project}`, intent: 'success' })
  void loadInstalls()
}

// ── row and bulk actions ────────────────────────────────────────────────────
const errorToast = (title: string, e: unknown) =>
  toast({ title, description: e instanceof Error ? e.message : String(e), intent: 'danger' })

async function setEnabled(ids: string[], enabled: boolean) {
  const failed: string[] = []
  for (const id of ids) {
    try {
      await api.setAssetEnabled(kind.value, id, enabled)
    } catch (e) {
      failed.push(id)
      errorToast(`Couldn't ${enabled ? 'enable' : 'disable'} ${id}`, e)
    }
  }
  await res.load()
  const n = ids.length - failed.length
  if (n)
    toast({ title: `${plural(n, 'item')} ${enabled ? 'enabled' : 'disabled'}`, intent: 'success' })
}

async function duplicate(id: string) {
  try {
    const detail = await api.getAsset(kind.value, id)
    const to = copyId(
      id,
      all.value.filter(a => a.kind === kind.value).map(a => a.id),
    )
    // A skill or agent keeps its own id inside its files only through the folder or file name, which the key carries.
    const files = Object.fromEntries(
      Object.entries(detail.files).map(([path, text]) => [
        path === `${id}.md` || path === `${id}.json` ? path.replace(id, to) : path,
        text,
      ]),
    )
    await api.saveAsset(kind.value, to, files)
    toast({ title: `Duplicated as ${to}`, intent: 'success' })
    await res.load()
  } catch (e) {
    errorToast("Couldn't duplicate", e)
  }
}

const exportTarget = ref<{ id: string; name: string } | null>(null)
const exporting = computed({
  get: () => exportTarget.value !== null,
  set: v => {
    if (!v) exportTarget.value = null
  },
})
const deleteTargets = ref<Target[]>([])
const deleting = ref(false)
function askDelete(ids: string[]) {
  deleteTargets.value = all.value
    .filter(a => a.kind === kind.value && ids.includes(a.id))
    .map(a => ({ kind: a.kind, id: a.id, name: a.name, enabled: a.enabled }))
  deleting.value = true
}
function gone() {
  selected.value = new Set()
  void res.load()
}

function onAction(id: string, action: RowAction) {
  const asset = all.value.find(a => a.kind === kind.value && a.id === id)
  if (!asset) return
  if (action === 'edit') open(id)
  else if (action === 'install') installTarget.value = { id, name: asset.name }
  else if (action === 'toggle') void setEnabled([id], !asset.enabled)
  else if (action === 'duplicate') void duplicate(id)
  else if (action === 'export') exportTarget.value = { id, name: asset.name }
  else askDelete([id])
}
const picked = computed(() => [...selected.value].map(String))

const open = (id: string) =>
  void router.push({ name: 'library-asset', params: { kind: kind.value, id } })

const creating = ref(false)
const importing = ref(false)
function created(k: AssetKind, id: string) {
  toast({ title: `Created ${id}`, intent: 'success' })
  void router.push({ name: 'library-asset', params: { kind: k, id } })
}

async function rescan() {
  try {
    await api.rescanLibrary()
    await res.load()
    toast({ title: 'Library rescanned', intent: 'success' })
  } catch (e) {
    toast({
      title: "Couldn't rescan",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  }
}

async function globalInstructions() {
  try {
    try {
      await api.getAsset('instruction', 'global')
    } catch (e) {
      if (!(e instanceof ApiRequestError) || e.status !== 404) throw e
      await api.saveAsset('instruction', 'global', {
        'AGENTS.md': '# Global instructions\n\nFollow the project instructions.\n',
      })
    }
    await router.push({ name: 'library-asset', params: { kind: 'instruction', id: 'global' } })
  } catch (e) {
    toast({
      title: "Couldn't open global instructions",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  }
}
</script>

<template>
  <div class="library">
    <IuSkeleton v-if="res.phase.value === 'loading'" shape="table" :rows="6" />
    <IuErrorState
      v-else-if="res.phase.value === 'error'"
      title="Couldn't load the library"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`library.load.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />
    <div v-else class="library__layout">
      <nav class="library__nav" aria-label="Library kinds">
        <h1 class="library__title">Library</h1>
        <ul class="library__links">
          <li v-for="t in tabs" :key="t.id">
            <button
              type="button"
              class="library__link"
              :aria-current="tab === t.id ? 'true' : undefined"
              @click="tab = t.id"
            >
              <span>{{ t.label }}</span>
              <span v-if="t.badge" class="library__count">{{ t.badge }}</span>
            </button>
          </li>
        </ul>
      </nav>

      <div class="library__main">
        <section class="library__section" :aria-labelledby="`library-h-${tab}`">
          <div class="library__section-head">
            <IuEyebrow :id="`library-h-${tab}`" as="h2" size="md">{{ currentLabel }}</IuEyebrow>
            <div class="library__actions">
              <IuButton variant="ghost" size="sm" @click="globalInstructions"
                >Global instructions</IuButton
              >
              <template v-if="!onGitTab">
                <IuButton
                  v-if="kind === 'plugin'"
                  variant="secondary"
                  size="sm"
                  @click="importing = true"
                  >Import…</IuButton
                >
                <IuButton variant="ghost" size="sm" @click="rescan">Rescan</IuButton>
                <IuButton variant="primary" size="sm" @click="creating = true"
                  >New {{ kindNoun(kind) }}</IuButton
                >
              </template>
            </div>
          </div>
          <p v-if="!onGitTab && KIND_INFO[kind].blurb" class="library__blurb">
            {{ KIND_INFO[kind].blurb }}
          </p>
          <div v-if="picked.length" class="library__bar" role="toolbar" aria-label="Bulk actions">
            <strong>{{ picked.length }} selected</strong>
            <IuButton size="sm" variant="secondary" @click="setEnabled(picked, true)"
              >Enable</IuButton
            >
            <IuButton size="sm" variant="secondary" @click="setEnabled(picked, false)"
              >Disable</IuButton
            >
            <IuButton size="sm" variant="secondary" @click="askDelete(picked)">Delete…</IuButton>
            <IuButton size="sm" variant="ghost" @click="selected = new Set()">Clear</IuButton>
          </div>

          <GitActionsPanel v-if="onGitTab" @count="gitActionCount = $event" />
          <McpPanel
            v-else-if="kind === 'mcp'"
            v-model:selected="selected"
            :installs="installs"
            @action="onAction"
            @toggle="(id, on) => setEnabled([id], on)"
          />
          <IuEmpty
            v-else-if="!rows.length"
            :eyebrow="false"
            :title="`No ${KIND_INFO[kind].plural.toLowerCase()} yet`"
            :body="`${KIND_INFO[kind].blurb} Create one, or drop files into the library folder and rescan.`"
          >
            <template #action>
              <IuButton variant="primary" @click="creating = true"
                >New {{ kindNoun(kind) }}</IuButton
              >
            </template>
          </IuEmpty>
          <div
            v-else
            class="library__list"
            :class="{ 'library__list--used': installable }"
            role="table"
          >
            <div class="library__list-head" role="row">
              <span class="library__check" role="columnheader">
                <IuCheckbox
                  :model-value="allSelected"
                  :indeterminate="someSelected"
                  :aria-label="`Select all ${KIND_INFO[kind].plural}`"
                  @update:model-value="toggleAll"
                />
              </span>
              <span role="columnheader">Name</span>
              <span role="columnheader">Updated</span>
              <span v-if="installable" role="columnheader">Used in</span>
              <span role="columnheader">Enabled</span>
              <span role="columnheader" />
            </div>
            <div v-for="row in rows" :key="row.id" class="library__item" role="row">
              <span class="library__check" role="cell">
                <IuCheckbox
                  :model-value="selected.has(row.id)"
                  :aria-label="`Select ${row.name}`"
                  @update:model-value="on => toggleRow(row.id, on)"
                />
              </span>
              <div class="library__identity" role="cell">
                <div class="library__name-row">
                  <RouterLink
                    class="library__name"
                    :to="{ name: 'library-asset', params: { kind, id: row.id } }"
                    >{{ row.name }}</RouterLink
                  >
                  <IuBadge v-if="row.error" intent="danger" size="xs">Has errors</IuBadge>
                  <IuBadge v-if="!row.enabled" intent="neutral" size="xs">Disabled</IuBadge>
                </div>
                <span v-if="row.name !== row.id" class="library__id">{{ row.id }}</span>
                <span v-if="row.description" class="library__desc">{{ row.description }}</span>
                <span v-if="row.detail" class="library__id">{{ row.detail }}</span>
              </div>
              <span class="library__meta" role="cell" :title="`Version ${row.version}`">{{
                relativeTime(row.updatedAt)
              }}</span>
              <span v-if="installable" class="library__meta" role="cell">
                <span v-if="row.installs === null" class="library__none">…</span>
                <span v-else-if="row.installs === 0" class="library__none">Not installed</span>
                <span v-else>{{ plural(row.installs, 'project') }}</span>
              </span>
              <span class="library__enabled" role="cell">
                <IuSwitch
                  size="sm"
                  :model-value="row.enabled"
                  :aria-label="`Enable ${row.name}`"
                  @update:model-value="setEnabled([row.id], $event)"
                />
              </span>
              <span class="library__more" role="cell">
                <IuMenu
                  :items="assetMenu(kind, row.enabled)"
                  fixed
                  @select="onAction(row.id, $event as RowAction)"
                >
                  <template #trigger="{ toggle }">
                    <IuButton
                      variant="ghost"
                      size="sm"
                      icon-only
                      :aria-label="`More actions for ${row.name}`"
                      @click.stop="toggle"
                    >
                      <template #icon><IuIcon name="more" /></template>
                    </IuButton>
                  </template>
                </IuMenu>
              </span>
            </div>
          </div>
        </section>
      </div>
    </div>

    <InstallModal
      v-if="installTarget && isInstallable(kind)"
      v-model:open="installing"
      :kind="kind"
      :id="installTarget.id"
      :name="installTarget.name"
      @installed="installed"
    />
    <NewAssetModal
      v-model:open="creating"
      :kind="kind"
      :taken="all.filter(a => a.kind === kind).map(a => a.id)"
      @created="created"
    />
    <DeleteAssetDialog v-model:open="deleting" :items="deleteTargets" @changed="gone" />
    <ExportPluginModal
      v-if="exportTarget"
      v-model:open="exporting"
      :id="exportTarget.id"
      :name="exportTarget.name"
    />
    <ImportPluginModal v-model:open="importing" @imported="id => open(id)" />
  </div>
</template>

<style>
.library {
  padding: 8px 0 64px;
  min-width: 0;
}
.library__layout {
  display: grid;
  grid-template-columns: minmax(120px, 168px) minmax(0, 640px);
  justify-content: center;
  gap: clamp(20px, 4vw, 56px);
  align-items: start;
}
.library__layout > * {
  min-width: 0;
}
.library__nav {
  position: sticky;
  top: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.library__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.library__links {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.library__link {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 4px 0 4px 14px;
  border: none;
  background: none;
  font: inherit;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
  text-align: left;
  cursor: pointer;
}
.library__link:hover,
.library__link[aria-current='true'] {
  color: var(--iu-text);
}
.library__link[aria-current='true']::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 4px;
  height: 4px;
  margin-top: -2px;
  border-radius: 50%;
  background: var(--iu-accent);
}
.library__link:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
  border-radius: var(--iu-radius-sm);
}
.library__count {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.library__main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.library__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  scroll-margin-top: 16px;
}
.library__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}
.library__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
}
.library__blurb {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.library__bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 0;
  font-size: var(--iu-font-size-13);
}
.library__bar strong {
  margin-right: 4px;
}
.library__list {
  border-top: 1px solid var(--iu-hairline);
}
.library__list-head,
.library__item {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) 72px 64px 32px;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  border-bottom: 1px solid var(--iu-hairline);
}
.library__list--used .library__list-head,
.library__list--used .library__item {
  grid-template-columns: 22px minmax(0, 1fr) 72px 92px 64px 32px;
}
.library__list-head {
  min-height: 0;
  padding: 6px 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
}
.library__check {
  display: flex;
  justify-content: center;
}
.library__identity {
  min-width: 0;
  padding: 8px 0;
}
.library__name-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}
.library__name,
.library__name:hover {
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
}
.library__name:hover {
  text-decoration: underline;
}
.library__id,
.library__desc {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.library__id {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.library__desc {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.library__meta {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  text-align: right;
  white-space: nowrap;
}
.library__none {
  color: var(--iu-text-muted);
}
.library__enabled,
.library__more {
  display: flex;
  justify-content: flex-end;
}
@media (max-width: 860px) {
  .library__layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
  .library__nav {
    position: static;
  }
  .library__links {
    flex-direction: row;
    flex-wrap: wrap;
    gap: 4px 12px;
  }
  .library__link {
    width: auto;
    padding-left: 12px;
  }
}
</style>
