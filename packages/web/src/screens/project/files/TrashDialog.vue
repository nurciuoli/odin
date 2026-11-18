<script setup lang="ts">
// The project's file trash: restore an item, delete it for good, or empty everything. Items go in with Trash and
// are purged by the server after 7 days.
import { computed, ref, watch } from 'vue'
import type { FileTrashEntry } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import { IuEmpty } from '@/components/States'
import { useToast } from '@/components/Toast'
import { relativeTime } from '@/screens/shared/format'
import { formatBytes } from './files'

const props = defineProps<{ project: string }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()

const api = useApi()
const { toast } = useToast()
const items = ref<FileTrashEntry[] | null>(null)
const error = ref('')
const busy = ref(false)

async function load() {
  try {
    items.value = await api.listProjectTrash(props.project)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    items.value = []
  }
}
watch(open, v => {
  if (v) {
    error.value = ''
    items.value = null
    void load()
  }
})

async function run(what: () => Promise<unknown>, done: string) {
  busy.value = true
  error.value = ''
  try {
    await what()
    toast({ title: done, intent: 'success' })
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
    await load()
  }
}
const restore = (t: FileTrashEntry) =>
  run(() => api.restoreProjectTrash(props.project, t.id), `Restored ${t.path}`)
const purge = (t: FileTrashEntry) =>
  run(() => api.purgeProjectTrash(props.project, t.id), `Deleted ${t.path} for good`)
const empty = () => run(() => api.purgeProjectTrash(props.project), 'Trash emptied')
const sorted = computed(() => items.value ?? [])
</script>

<template>
  <IuDialog v-model:open="open" size="md">
    <template #header>
      <h2 class="files__dialog-h">Trash</h2>
    </template>
    <p class="files__dialog-p">Deleted files stay here for 7 days, then are removed for good.</p>
    <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    <p v-if="items === null" class="files__dialog-p" role="status">Loading…</p>
    <IuEmpty
      v-else-if="!sorted.length"
      :eyebrow="false"
      title="The trash is empty"
      body="Files you delete show up here."
    />
    <ul v-else class="files__trash" aria-label="Trashed files">
      <li v-for="t in sorted" :key="t.id">
        <span class="files__trash-name">{{ t.path }}{{ t.kind === 'directory' ? '/' : '' }}</span>
        <span class="files__trash-meta"
          >{{ t.size === null ? '' : `${formatBytes(t.size)} · `
          }}{{ relativeTime(t.trashedAt) }}</span
        >
        <IuButton size="sm" variant="secondary" :disabled="busy" @click="restore(t)"
          >Restore</IuButton
        >
        <IuButton size="sm" variant="ghost" :disabled="busy" @click="purge(t)"
          >Delete for good</IuButton
        >
      </li>
    </ul>
    <template #footer>
      <IuButton variant="ghost" @click="open = false">Close</IuButton>
      <IuButton variant="danger" :disabled="busy || !sorted.length" @click="empty"
        >Empty trash</IuButton
      >
    </template>
  </IuDialog>
</template>
