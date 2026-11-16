<script setup lang="ts">
// Library files against the project's copy of one installed asset.
import { ref, watch } from 'vue'
import type { Installation } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuDiff } from '@/components/CodeBlock'
import { IuButton } from '@/components/Button'
import { IuDialog } from '@/components/Modal'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { assetDiff, type FileDiff } from './driftModel'

const props = defineProps<{ installation: Installation | null; name: string }>()
const open = defineModel<boolean>('open', { required: true })

const api = useApi()
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')
const diffs = ref<FileDiff[]>([])

async function load() {
  const i = props.installation
  if (!i) return
  phase.value = 'loading'
  try {
    const [lib, project] = await Promise.all([
      api.getAsset(i.kind, i.id),
      // a missing project file is an answer, not a failure
      api.getProjectAssetFiles(i.project, i.kind, i.id).catch(() => ({})),
    ])
    diffs.value = assetDiff(lib.files, project)
    phase.value = 'ready'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    phase.value = 'error'
  }
}
watch(
  () => [open.value, props.installation?.kind, props.installation?.id] as const,
  ([isOpen]) => {
    if (isOpen) void load()
  },
  { immediate: true },
)
</script>

<template>
  <IuDialog v-model:open="open" size="lg">
    <template #header>
      <h2 class="asset-diff__title">Library against project: {{ name }}</h2>
    </template>
    <p class="asset-diff__note">
      Removed lines are the library's version; added lines are the project's.
    </p>
    <IuSkeleton v-if="phase === 'loading'" shape="card" :rows="2" />
    <IuErrorState
      v-else-if="phase === 'error'"
      title="Couldn't load the files"
      :body="error"
      trace-id="project.library.diff"
      @retry="load()"
    />
    <IuEmpty v-else-if="!diffs.length" title="No files to compare" />
    <div v-else class="asset-diff__files">
      <IuDiff
        v-for="d in diffs"
        :key="d.path"
        :hunks="d.hunks"
        :filename="d.path"
        max-height="320px"
      />
    </div>
    <template #footer>
      <IuButton variant="secondary" size="sm" @click="open = false">Close</IuButton>
    </template>
  </IuDialog>
</template>

<style>
.asset-diff__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.asset-diff__note {
  margin: 0 0 12px;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.asset-diff__files {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
