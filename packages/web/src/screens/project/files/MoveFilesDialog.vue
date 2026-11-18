<script setup lang="ts">
// Choose a folder to move files into. Folders come from the tree, so only folders that hold files are listed.
import { computed, ref, watch } from 'vue'
import type { FileMoveResult } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuIcon } from '@/components/Icon'
import { IuDialog } from '@/components/Modal'
import { moveTargets } from './files'

const props = defineProps<{
  project: string
  paths: string[]
  folders: string[]
  rootName: string
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ moved: [result: FileMoveResult] }>()

const api = useApi()
const targets = computed(() => moveTargets(props.folders, props.paths))
const chosen = ref<string | null>(null)
const busy = ref(false)
const error = ref('')
watch(open, v => {
  if (v) {
    chosen.value = null
    error.value = ''
  }
})

const label = (f: string) => (f ? f : `${props.rootName} (project root)`)
const depth = (f: string) => (f ? f.split('/').length : 0)
const title = computed(() =>
  props.paths.length === 1
    ? `Move “${props.paths[0]!.split('/').pop()}”`
    : `Move ${props.paths.length} items`,
)

async function submit() {
  if (chosen.value === null) return
  busy.value = true
  error.value = ''
  try {
    const result = await api.moveProjectFiles(props.project, props.paths, chosen.value)
    open.value = false
    emit('moved', result)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" size="sm">
    <template #header>
      <h2 class="files__dialog-h">{{ title }}</h2>
    </template>
    <p class="files__dialog-p">Choose a folder in the project.</p>
    <ul v-if="targets.length" class="files__tree" role="listbox" aria-label="Destination folder">
      <li
        v-for="f in targets"
        :key="f"
        role="option"
        tabindex="0"
        :aria-selected="chosen === f"
        :class="{ 'files__tree-on': chosen === f }"
        :style="{ paddingLeft: `${12 + depth(f) * 18}px` }"
        @click="chosen = f"
        @keydown.enter.prevent="chosen = f"
        @keydown.space.prevent="chosen = f"
      >
        <IuIcon name="folder" :size="14" />
        <span>{{ f ? f.split('/').pop() : label(f) }}</span>
        <IuIcon v-if="chosen === f" name="check" :size="14" />
      </li>
    </ul>
    <p v-else class="files__dialog-p">There is no other folder to move these into.</p>
    <p v-if="chosen !== null" class="files__dialog-p">
      New location:
      <code
        >{{ chosen ? `${chosen}/` : ''
        }}{{ paths.length === 1 ? paths[0]!.split('/').pop() : '…' }}</code
      >
    </p>
    <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    <template #footer>
      <IuButton variant="ghost" @click="open = false">Cancel</IuButton>
      <IuButton variant="primary" :loading="busy" :disabled="chosen === null" @click="submit"
        >Move here</IuButton
      >
    </template>
  </IuDialog>
</template>
