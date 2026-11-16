<script setup lang="ts">
// Where an asset is installed, with each project's drift state and what you can do about it.
import { computed, ref } from 'vue'
import type { AssetDetail, Installation, InstallRequest } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import { IuEmpty } from '@/components/States'
import { IuTable, type Column } from '@/components/Table'
import { useToast } from '@/components/Toast'
import { shortHash } from '@/screens/shared/format'
import { DRIFT_DISPLAY } from './assetForm'

const props = defineProps<{ detail: AssetDetail; installable: boolean }>()
const emit = defineEmits<{ changed: []; install: [] }>()

const api = useApi()
const { toast } = useToast()

type Row = {
  project: string
  state: string
  installed: string
  inProject: string
  actions: string
}
const rows = computed<Row[]>(() =>
  props.detail.installs.map(i => ({
    project: i.project,
    state: i.state,
    installed: shortHash(i.installedVersion),
    inProject: i.projectVersion ? shortHash(i.projectVersion) : 'gone',
    actions: '',
  })),
)
const columns: Column<Row>[] = [
  { key: 'project', header: 'Project', sortable: true },
  { key: 'state', header: 'State', width: '200px' },
  { key: 'installed', header: 'Installed', width: '110px' },
  { key: 'inProject', header: 'In project', width: '110px' },
  { key: 'actions', header: 'Actions', width: '340px' },
]
const byProject = computed(() => new Map(props.detail.installs.map(i => [i.project, i])))

const busy = ref<string | null>(null)
const confirm = ref<Installation | null>(null)

async function run(inst: Installation, action: InstallRequest['action'], force = false) {
  busy.value = `${inst.project}:${action}`
  try {
    await api.install(inst.project, {
      kind: inst.kind,
      id: inst.id,
      action,
      ...(force ? { force: true } : {}),
    })
    toast({
      title:
        action === 'update'
          ? `Updated ${inst.project}`
          : action === 'push'
            ? `Pushed ${inst.project}'s copy to the library`
            : `Stopped tracking in ${inst.project}`,
      intent: 'success',
    })
    emit('changed')
  } catch (e) {
    toast({
      title: `Couldn't ${action === 'push' ? 'push' : action} in ${inst.project}`,
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    busy.value = null
  }
}
function overwrite() {
  const inst = confirm.value
  confirm.value = null
  if (inst) void run(inst, 'update', true)
}
</script>

<template>
  <div class="installs">
    <IuEmpty
      v-if="!detail.installs.length"
      title="Not installed anywhere"
      :body="
        installable
          ? 'Install it into a project to use it there. Odin tracks drift from then on.'
          : 'This kind is used from the library; it isn’t installed into projects.'
      "
    >
      <template v-if="installable" #action>
        <IuButton variant="secondary" @click="emit('install')">Install into a project…</IuButton>
      </template>
    </IuEmpty>
    <IuTable v-else :columns="columns" :rows="rows" :row-key="r => r.project">
      <template #cell:project="{ row }">
        <RouterLink :to="`/p/${row.project}/library`">{{ row.project }}</RouterLink>
      </template>
      <template #cell:state="{ row }">
        <IuBadge
          :intent="DRIFT_DISPLAY[byProject.get(row.project)!.state].intent"
          :title="DRIFT_DISPLAY[byProject.get(row.project)!.state].hint"
          dot
          >{{ DRIFT_DISPLAY[byProject.get(row.project)!.state].label }}</IuBadge
        >
      </template>
      <template #cell:actions="{ row }">
        <div class="installs__actions">
          <template v-for="i in [byProject.get(row.project)!]" :key="i.project">
            <IuButton
              v-if="i.state === 'update-available' || i.state === 'missing'"
              size="sm"
              variant="secondary"
              :loading="busy === `${i.project}:update`"
              :aria-label="`${i.state === 'missing' ? 'Reinstall' : 'Update'} in ${i.project}`"
              @click="run(i, 'update')"
              >{{ i.state === 'missing' ? 'Reinstall' : 'Update' }}</IuButton
            >
            <template v-if="i.state === 'modified' || i.state === 'conflict'">
              <IuButton
                size="sm"
                variant="secondary"
                :loading="busy === `${i.project}:push`"
                :aria-label="`Push ${i.project}'s copy to the library`"
                @click="run(i, 'push')"
                >Push to library</IuButton
              >
              <IuButton
                size="sm"
                variant="secondary"
                :aria-label="`Overwrite ${i.project}'s copy with the library version`"
                @click="confirm = i"
                >Overwrite</IuButton
              >
            </template>
            <IuButton
              size="sm"
              variant="ghost"
              :loading="busy === `${i.project}:forget`"
              :aria-label="`Stop tracking in ${i.project}`"
              @click="run(i, 'forget')"
              >Forget</IuButton
            >
          </template>
        </div>
      </template>
    </IuTable>

    <IuDialog :open="!!confirm" size="sm" @update:open="!$event && (confirm = null)">
      <template #header>
        <h2 class="installs__title">Overwrite the project copy?</h2>
      </template>
      <IuCallout intent="warning" variant="inline">
        {{ confirm?.project }} has edits to this {{ confirm?.kind }} that aren't in the library.
        Overwriting replaces them with the library version. Push them to the library first to keep
        them.
      </IuCallout>
      <template #footer>
        <IuButton variant="secondary" size="sm" @click="confirm = null">Cancel</IuButton>
        <IuButton variant="danger" size="sm" @click="overwrite">Overwrite</IuButton>
      </template>
    </IuDialog>
  </div>
</template>

<style>
.installs__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.installs__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
</style>
