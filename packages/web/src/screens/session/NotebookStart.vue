<script setup lang="ts">
// The page a new notebook starts on: a name and a Python environment. Creating it links the kernel to this session
// and the page becomes the notebook.
import { computed, ref } from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import type { KernelLocation, NotebookEnvironment } from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import DocumentHeader from './DocumentHeader.vue'
import { notebookFileName } from './documents'

const props = withDefaults(defineProps<{ session: SessionDetail; name?: string }>(), {
  name: 'Analysis',
})
const emit = defineEmits<{ close: []; created: [kernelId: string] }>()
const api = useApi()
const name = ref(props.name)
const distro = ref('')
const environment = ref<NotebookEnvironment | null>(null)
const environmentLocation = ref('')
const error = ref('')
const busy = ref(false)
const location = (): KernelLocation =>
  distro.value.trim() ? { kind: 'wsl', distro: distro.value.trim() } : { kind: 'native' }
async function action(fn: () => Promise<void>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
const detect = () =>
  action(async () => {
    environment.value = await api.notebookEnvironment(props.session.project, location())
    environmentLocation.value = JSON.stringify(location())
  })
const setup = () =>
  action(async () => {
    environment.value = await api.setupNotebookEnvironment(props.session.project, location())
    environmentLocation.value = JSON.stringify(location())
  })
const create = () =>
  action(async () => {
    if (!environment.value?.interpreter || environmentLocation.value !== JSON.stringify(location()))
      throw new Error('Detect or set up the environment first')
    const kernel = await api.createNotebook(props.session.project, {
      name: name.value.trim(),
      interpreter: environment.value.interpreter,
      location: location(),
    })
    await api.attachNotebook(props.session.id, kernel.id)
    emit('created', kernel.id)
  })
const summary = computed(() =>
  environment.value
    ? `${environment.value.kind} · ${environment.value.interpreter || 'No Python environment found'}${environment.value.needsSetup ? ' · Setup required' : ''}`
    : 'Not checked yet',
)
</script>

<template>
  <section class="nb-start" aria-label="New notebook">
    <DocumentHeader
      :name="notebookFileName(name.trim() || 'Untitled')"
      icon="terminal"
      status="Not created"
      @close="emit('close')"
    />
    <div class="nb-start__body">
      <p class="nb-start__lede">
        A notebook runs Python in a kernel that stays alive between cells. This session and you both
        work in it.
      </p>
      <IuField
        label="Name"
        size="sm"
        :model-value="name"
        @update:model-value="name = String($event)"
      />
      <IuField
        label="WSL distro"
        hint="Leave blank to run natively."
        size="sm"
        :model-value="distro"
        @update:model-value="distro = String($event)"
      />
      <div class="nb-start__row">
        <IuButton size="sm" variant="secondary" :disabled="busy" @click="detect"
          >Detect environment</IuButton
        >
        <IuButton size="sm" variant="ghost" :disabled="busy" @click="setup"
          >Set up Python environment</IuButton
        >
      </div>
      <p class="nb-start__env" aria-live="polite">{{ summary }}</p>
      <IuCallout v-if="error" intent="danger" variant="subtle" live>{{ error }}</IuCallout>
      <div>
        <IuButton
          variant="primary"
          :disabled="busy || !name.trim() || !environment?.interpreter || environment.needsSetup"
          @click="create"
          >Create and attach</IuButton
        >
      </div>
    </div>
  </section>
</template>

<style>
.nb-start {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
}
.nb-start__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 420px;
  padding: 16px;
  overflow: auto;
}
.nb-start__lede,
.nb-start__env {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12-5);
  line-height: var(--iu-leading-normal);
}
.nb-start__env {
  font-family: var(--iu-font-mono);
  overflow-wrap: anywhere;
}
.nb-start__row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
