<script setup lang="ts">
// The kernel prompt, in place: a notebook has no Python environment (or a run said so). Detect the project's, or set
// one up, natively or in WSL; once one is found the notebook opens again with it. Nothing runs until then.
import { computed, ref } from 'vue'
import type { KernelLocation, NotebookEnvironment } from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField } from '@/components/Fields'
import { IuSegmented } from '@/components/Segmented'

const props = defineProps<{ project: string }>()
const emit = defineEmits<{
  ready: [environment: { interpreter: string; location: KernelLocation }]
}>()
const api = useApi()
const where = ref<'native' | 'wsl'>('native')
const distro = ref('')
const environment = ref<NotebookEnvironment | null>(null)
const error = ref('')
const busy = ref(false)
const location = (): KernelLocation =>
  where.value === 'wsl' ? { kind: 'wsl', distro: distro.value.trim() } : { kind: 'native' }
const wslMissing = computed(() => where.value === 'wsl' && !distro.value.trim())

async function run(fn: () => Promise<NotebookEnvironment>) {
  if (busy.value) return
  if (wslMissing.value) {
    error.value = 'Enter the WSL distro to use.'
    return
  }
  busy.value = true
  error.value = ''
  try {
    environment.value = await fn()
    const { interpreter, needsSetup } = environment.value
    if (interpreter && !needsSetup) emit('ready', { interpreter, location: location() })
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
const detect = () => run(() => api.notebookEnvironment(props.project, location()))
const setup = () => run(() => api.setupNotebookEnvironment(props.project, location()))
const summary = computed(() =>
  environment.value
    ? `${environment.value.kind} · ${environment.value.interpreter || 'No Python environment found'}${environment.value.needsSetup ? ' · Setup required' : ''}`
    : '',
)
</script>

<template>
  <IuCallout intent="warning" variant="subtle" title="No Python environment">
    <p class="nb-env__text">
      This notebook has no Python to run on, so cells can’t run yet. Detect this project’s
      environment, or set one up.
    </p>
    <div class="nb-env__where">
      <IuSegmented
        v-model="where"
        label="Where Python runs"
        :options="[
          { value: 'native', label: 'Native' },
          { value: 'wsl', label: 'WSL' },
        ]"
      />
      <IuField
        v-if="where === 'wsl'"
        label="WSL distro"
        size="sm"
        :model-value="distro"
        @update:model-value="distro = String($event)"
      />
    </div>
    <p v-if="summary" class="nb-env__summary" aria-live="polite">{{ summary }}</p>
    <p v-if="error" class="nb-env__error" role="alert">{{ error }}</p>
    <template #actions>
      <IuButton size="sm" variant="secondary" :disabled="busy" @click="detect"
        >Detect environment</IuButton
      >
      <IuButton size="sm" variant="ghost" :disabled="busy" @click="setup"
        >Set up Python environment</IuButton
      >
    </template>
  </IuCallout>
</template>

<style>
.nb-env__text,
.nb-env__summary,
.nb-env__error {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  overflow-wrap: anywhere;
}
.nb-env__where {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
  margin-top: 8px;
}
.nb-env__summary {
  margin-top: 8px;
  font-family: var(--iu-font-mono);
  color: var(--iu-text-muted);
}
.nb-env__error {
  margin-top: 8px;
  color: var(--iu-danger);
}
</style>
