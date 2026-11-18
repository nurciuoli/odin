<script setup lang="ts">
// The panel's Environment tab: is Python ready for notebooks, and one button to make it so. Where Python runs (this
// machine, or WSL on Windows) is found by the server, not asked of the person. Below it, the project's notebook
// kernels and their state.
import { computed, onMounted, ref } from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import type { NotebookEnvironment, NotebookKernel } from '@odin/shared/notebooks'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuPropertyList, type PropertyItem } from '@/components/PropertyList'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { IuStatusDot } from '@/components/StatusDot'
import type { Status } from '@/styles/status'

const props = defineProps<{ session: SessionDetail }>()
const api = useApi()

const phase = ref<'loading' | 'ready' | 'error'>('loading')
const loadError = ref('')
const environment = ref<NotebookEnvironment | null>(null)
const kernels = ref<NotebookKernel[]>([])
const busy = ref(false)
const settingUp = ref(false)
const error = ref('')

const ready = computed(() => !!environment.value?.interpreter && !environment.value.needsSetup)
const where = (found: NotebookEnvironment) =>
  found.location.kind === 'wsl' ? `WSL (${found.location.distro})` : 'This computer'
const summary = computed(() => {
  const found = environment.value
  if (!found) return ''
  if (ready.value) return 'Python is ready for notebooks.'
  if (found.interpreter) return 'Python was found. One more step makes it ready for notebooks.'
  return 'No Python environment yet. Set one up and notebooks can run.'
})
const details = computed<PropertyItem[]>(() => {
  const found = environment.value
  if (!found?.interpreter) return []
  return [
    { label: 'Interpreter', value: found.interpreter, mono: true },
    { label: 'Runs on', value: where(found) },
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
      api.notebookEnvironment(props.session.project),
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
    environment.value = await api.notebookEnvironment(props.session.project)
  })
const setup = () =>
  run(async () => {
    settingUp.value = true
    try {
      environment.value = await api.setupNotebookEnvironment(props.session.project)
    } finally {
      settingUp.value = false
    }
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
        <p class="session-env__summary" :data-ready="ready" role="status">
          <IuStatusDot :status="ready ? 'ok' : 'idle'" :size="8" decorative />
          {{ settingUp ? 'Setting up Python. This can take a minute or two.' : summary }}
        </p>
        <IuPropertyList :items="details" density="compact" label-width="96px" />
        <p v-if="error" class="session-env__error" role="alert">{{ error }}</p>
        <div class="session-env__actions">
          <IuButton
            v-if="!ready"
            size="sm"
            variant="primary"
            :disabled="busy"
            :loading="settingUp"
            @click="setup"
            >{{ environment?.interpreter ? 'Finish setup' : 'Set up Python' }}</IuButton
          >
          <IuButton size="sm" variant="ghost" :disabled="busy" @click="detect"
            >Check again</IuButton
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
.session-env__summary {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--iu-font-size-12-5);
}
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
