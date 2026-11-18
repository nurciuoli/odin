<script setup lang="ts">
// Confirm deleting library items. Says how many projects have each installed, and offers to switch them off instead.
import { ref, watch } from 'vue'
import type { AssetKind } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import { plural } from '@/screens/shared/format'

export type Target = { kind: AssetKind; id: string; name: string; enabled: boolean }

const props = defineProps<{ items: Target[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ changed: [] }>()

const api = useApi()
const installs = ref<number | null>(null)
const busy = ref(false)
const error = ref<string | null>(null)

watch(open, async v => {
  if (!v) return
  installs.value = null
  error.value = null
  const counts = await Promise.all(
    props.items.map(i =>
      api
        .getAsset(i.kind, i.id)
        .then(d => d.installs.length)
        .catch(() => 0),
    ),
  )
  installs.value = counts.reduce((a, b) => a + b, 0)
})

async function run(what: 'delete' | 'disable') {
  busy.value = true
  error.value = null
  const done: string[] = []
  try {
    for (const i of props.items) {
      if (what === 'delete') await api.deleteAsset(i.kind, i.id)
      else await api.setAssetEnabled(i.kind, i.id, false)
      done.push(i.id)
    }
    open.value = false
    emit('changed')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    if (done.length) emit('changed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" size="sm">
    <template #header>
      <h2 class="library__dialog-h">
        Delete {{ items.length === 1 ? `“${items[0]?.name}”` : plural(items.length, 'item') }}?
      </h2>
    </template>
    <p class="library__dialog-p">
      <template v-if="installs === null">Checking where it is used…</template>
      <template v-else-if="installs === 0">It isn't installed in any project.</template>
      <template v-else>
        It is installed {{ plural(installs, 'time') }} across your projects. Deleting removes it
        from the Library. Files already copied into a project stay where they are.
      </template>
      This can't be undone.
    </p>
    <IuCallout v-if="items.some(i => i.enabled)" intent="info" variant="inline">
      Only want to pause it? Disable keeps it in the Library and installed, but it can no longer be
      installed or used to start sessions.
    </IuCallout>
    <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    <template #footer>
      <IuButton variant="ghost" @click="open = false">Cancel</IuButton>
      <IuButton
        v-if="items.some(i => i.enabled)"
        variant="secondary"
        :disabled="busy"
        @click="run('disable')"
        >Disable instead</IuButton
      >
      <IuButton variant="danger" :loading="busy" @click="run('delete')">Delete</IuButton>
    </template>
  </IuDialog>
</template>

<style>
.library__dialog-h {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.library__dialog-p {
  margin: 0 0 12px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
</style>
