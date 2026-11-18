<script setup lang="ts">
// The library: reusable agents, skills, commands, prompts, templates, MCP servers and settings profiles. One tab per
// kind, a table per tab, "New" per kind. The kind lives in the URL (?kind=).
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AssetKind, LibraryAsset } from '@odin/shared/api'
import { LIBRARY_KINDS } from '@odin/shared/library'
import { ApiRequestError, useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuPageHeader } from '@/components/PageHeader'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { IuTable, type Column } from '@/components/Table'
import { IuTabs } from '@/components/Tabs'
import { useToast } from '@/components/Toast'
import { plural, relativeTime, shortHash } from '@/screens/shared/format'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import { isAssetKind, KIND_INFO, kindNoun } from './assetForm'
import ImportPluginModal from './ImportPluginModal.vue'
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
  set: k => void router.replace({ query: { ...route.query, kind: k } }),
})

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
const tabs = computed(() =>
  LIBRARY_KINDS.map(k => ({
    id: k,
    label: KIND_INFO[k].plural,
    badge: all.value.filter(a => a.kind === k).length,
  })),
)

type Row = {
  key: string
  id: string
  name: string
  description: string
  version: string
  updatedAt: string
  installs: number | null
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
      version: shortHash(a.version),
      updatedAt: a.updatedAt,
      installs: installs.value ? (installs.value[`${a.kind}/${a.id}`] ?? 0) : null,
      error: a.error,
    })),
)
const columns = computed<Column<Row>[]>(() => [
  { key: 'name', header: 'Name', sortable: true, width: '24%' },
  { key: 'description', header: 'Description' },
  { key: 'version', header: 'Version', width: '96px' },
  { key: 'updatedAt', header: 'Updated', sortable: true, width: '110px' },
  { key: 'installs', header: 'Installs', numeric: true, align: 'end', width: '90px' },
])

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
    <IuPageHeader
      title="Library"
      subtitle="Instructions, skills, subagents, MCP servers, settings and plugins across projects"
      icon="folder"
    >
      <template #actions>
        <IuButton variant="secondary" @click="globalInstructions">Global instructions</IuButton>
        <IuButton v-if="kind === 'plugin'" variant="secondary" @click="importing = true"
          >Import…</IuButton
        >
        <IuButton variant="ghost" @click="rescan">Rescan</IuButton>
        <IuButton variant="primary" @click="creating = true">New {{ kindNoun(kind) }}</IuButton>
      </template>
    </IuPageHeader>

    <IuSkeleton v-if="res.phase.value === 'loading'" shape="table" :rows="6" />
    <IuErrorState
      v-else-if="res.phase.value === 'error'"
      title="Couldn't load the library"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`library.load.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />
    <IuTabs v-else v-model="kind" :tabs="tabs" :lazy="false" overflow="wrap">
      <template v-for="k in LIBRARY_KINDS" :key="k" #[`panel:${k}`]>
        <div v-if="k === kind" class="library__panel">
          <IuEmpty
            v-if="!rows.length"
            :title="`No ${KIND_INFO[k].plural.toLowerCase()} yet`"
            :body="`Create one, or drop files into the library folder and rescan.`"
          >
            <template #action>
              <IuButton variant="primary" @click="creating = true">New {{ kindNoun(k) }}</IuButton>
            </template>
          </IuEmpty>
          <IuTable
            v-else
            :columns="columns"
            :rows="rows"
            :row-key="r => r.key"
            @row-activate="open($event.id)"
          >
            <template #cell:name="{ row }">
              <RouterLink
                class="library__name"
                :to="{ name: 'library-asset', params: { kind: k, id: row.id } }"
                >{{ row.name }}</RouterLink
              >
              <IuBadge v-if="row.error" intent="danger" size="xs">Has errors</IuBadge>
              <span v-if="row.name !== row.id" class="library__id">{{ row.id }}</span>
            </template>
            <template #cell:description="{ row }">
              <span class="library__desc">{{ row.description }}</span>
            </template>
            <template #cell:version="{ row }">
              <code>{{ row.version }}</code>
            </template>
            <template #cell:updatedAt="{ row }">{{ relativeTime(row.updatedAt) }}</template>
            <template #cell:installs="{ row }">
              <span v-if="row.installs === null" class="library__id">…</span>
              <template v-else
                >{{ row.installs
                }}<span class="library__sr">
                  {{ plural(row.installs, 'project').replace(/^\d+ /, '') }}</span
                ></template
              >
            </template>
          </IuTable>
        </div>
      </template>
    </IuTabs>

    <NewAssetModal
      v-model:open="creating"
      :kind="kind"
      :taken="all.filter(a => a.kind === kind).map(a => a.id)"
      @created="created"
    />
    <ImportPluginModal v-model:open="importing" @imported="id => open(id)" />
  </div>
</template>

<style>
.library {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-top: 16px;
}
.library__panel {
  padding-top: 16px;
}
.library__name {
  font-weight: var(--iu-font-weight-medium);
  margin-right: 8px;
}
.library__id {
  display: block;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.library__desc {
  color: var(--iu-text-2);
}
.library__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
