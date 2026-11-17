<script setup lang="ts">
// The panel's Environment tab: the project's Python and Jupyter setup. What was detected (and a way to look again or
// set one up), where Python runs, and the project's notebook kernels with their state. A notebook's kernel chip points
// here for anything beyond picking up a detected interpreter.
import { computed, onMounted, ref } from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import type { KernelLocation, NotebookEnvironment, NotebookKernel } from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { getDesktop } from '@/app/desktop'
import { IuButton } from '@/components/Button'
import { IuField } from '@/components/Fields'
import { IuPropertyList, type PropertyItem } from '@/components/PropertyList'
import { IuSegmented } from '@/components/Segmented'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { IuStatusDot } from '@/components/StatusDot'
import type { Status } from '@/styles/status'
import { wslAvailable } from './notebookLayout'

const props = defineProps<{ session: SessionDetail }>()
const api = useApi()

const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const environment = ref<NotebookEnvironment | null>(null)
const kernels = ref<NotebookKernel[]>([])
const where = ref<'native' | 'wsl'>('native')
const distro = ref('')
const busy = ref(false)
const error = ref('')
const wslOption = wslAvailable(getDesktop()?.platform)

const location = (): KernelLocation =>
  where.value === 'wsl' ? { kind: 'wsl', distro: distro.value.trim() } : { kind: 'native' }
const wslMissing = computed(() => where.value === 'wsl' && !distro.value.trim())
const kindLabel: Record<NotebookEnvironment['kind'], string> = {
  venv: 'venv',
  uv: 'uv',
  poetry: 'Poetry',
  conda: 'Conda',
  missing: 'None found',
}
const details = computed<PropertyItem[]>(() => {
  const found = environment.value
  if (!found) return []
  return [
    { label: 'Kind', value: kindLabel[found.kind] },
    { label: 'Interpreter', value: found.interpreter ?? 'None', mono: true },
    { label: 'Setup', value: found.needsSetup ? 'Required' : 'Ready' },
  ]
})
const kernelStatus = (k: NotebookKernel): Status =>
  k.state === 'busy' || k.state === 'starting'
    ? 'running'
    : k.state === 'failed'
      ? 'failed'
      : k.state === 'idle'
        ? 'ok'
        : 'idle'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
async function load() {
  phase.value = 'loading'
  try {
    const [found, list] = await Promise.all([
      api.notebookEnvironment(props.session.project, location()),
      api.listNotebooks(props.session.project),
    ])
    environment.value = found
    kernels.value = list
    phase.value = 'ready'
  } catch (e) {
    loadError.value = message(e)
    phase.value = 'error'
  }
}
async function run(fn: () => Promise<void>) {
  if (busy.value) return
  if (wslMissing.value) {
    error.value = 'Enter the WSL distro to use.'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await fn()
  } catch (e) {
    error.value = message(e)
  } finally {
    busy.value = false
  }
}
const detect = () =>
  run(async () => {
    environment.value = await api.notebookEnvironment(props.session.project, location())
  })
const setup = () =>
  run(async () => {
    environment.value = await api.setupNotebookEnvironment(props.session.project, location())
  })
const stop = (kernel: NotebookKernel) =>
  run(async () => {
    await api.stopNotebook(kernel.id)
    kernels.value = await api.listNotebooks(props.session.project)
  })
onMounted(load)
</script>

<template>
  <section class="session-env" aria-label="Python environment">
    <div v-if="phase === 'loading'" class="session-env__state" aria-busy="true">
      <IuSkeleton shape="text" :rows="6" />
    </div>
    <div v-else-if="phase === 'error'" class="session-env__state">
      <IuErrorState
        title="Couldn’t read the environment"
        :body="loadError"
        :trace-id="`GET ${session.project}/notebook-environment`"
        @retry="load"
      />
    </div>
    <template v-else>
      <div class="session-env__block">
        <h3 class="session-env__title">Python environment</h3>
        <IuPropertyList :items="details" density="compact" label-width="96px" />
        <div v-if="wslOption" class="session-env__where">
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
        <p v-if="error" class="session-env__error" role="alert">{{ error }}</p>
        <div class="session-env__actions">
          <IuButton size="sm" variant="secondary" :disabled="busy" @click="detect"
            >Detect again</IuButton
          >
          <IuButton size="sm" variant="ghost" :disabled="busy" @click="setup"
            >Set up Python environment</IuButton
          >
        </div>
      </div>
      <div class="session-env__block">
        <h3 class="session-env__title">Notebook kernels</h3>
        <IuEmpty
          v-if="!kernels.length"
          title="No notebook kernels yet"
          body="A kernel starts the first time a notebook runs a cell."
        />
        <ul v-else class="session-env__kernels">
          <li v-for="kernel in kernels" :key="kernel.id" class="session-env__kernel">
            <IuStatusDot :status="kernelStatus(kernel)" :size="8" decorative />
            <span class="session-env__name" :title="kernel.path">{{ kernel.path }}</span>
            <span class="session-env__state-word">{{ kernel.state }}</span>
            <IuButton
              size="sm"
              variant="ghost"
              :disabled="busy || kernel.state === 'stopped'"
              :aria-label="`Stop kernel for ${kernel.path}`"
              @click="stop(kernel)"
              >Stop</IuButton
            >
          </li>
        </ul>
      </div>
    </template>
  </section>
</template>

<style>
.session-env {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 20px;
  overflow: auto;
  padding: 16px;
}
.session-env__block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.session-env__title {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-11);
  font-weight: var(--iu-font-weight-medium);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
}
.session-env__where,
.session-env__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 8px;
}
.session-env__error {
  margin: 0;
  color: var(--iu-danger);
  font-size: var(--iu-font-size-12-5);
}
.session-env__kernels {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.session-env__kernel {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.session-env__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
}
.session-env__state-word {
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
}
.session-env__state {
  padding: 0;
}
</style>
