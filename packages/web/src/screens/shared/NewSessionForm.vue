<script setup lang="ts">
// The existing chat input, with launch-only configuration in its toolbar.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type {
  AppSettings,
  Attachment,
  HarnessInfo,
  ModelInfo,
  PermissionMode,
  Session,
} from '@odin/shared/api'
import { useApi } from '@/api'
import { useDrafts } from '@/app/drafts'
import { useProjects } from '@/app/projects'
import { keyLabel, registerShortcut } from '@/app/shortcuts'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import type { Attachment as ChatAttachment } from '@/components/Chat'
import { IuComposer } from '@/components/Composer'
import { IuIcon } from '@/components/Icon'
import { useToast } from '@/components/Toast'
import { attachmentProblem, messageProblem, readAttachment } from '@/screens/session/attachments'
import ComposerChoice from './ComposerChoice.vue'
import NativeControls from './NativeControls.vue'
import { effortChoices, asEffort, pickerExtras } from './effort'
import ComposerProjects from './ComposerProjects.vue'
import ComposerWhere from './ComposerWhere.vue'
import Murmuration from './Murmuration.vue'
import { lastRuntime, rememberRuntime } from './lastRuntime'
import { harnessLabel, PERMISSION_MODE_LABELS } from './format'
import {
  buildStartRequest,
  emptySessionForm,
  recentBranchPrefixes,
  validateSessionForm,
  worktreeDefault,
  type SessionFormErrors,
} from './newSessionForm'

const props = withDefaults(
  defineProps<{
    project?: string
    autofocus?: boolean
    visual?: boolean
    /**
     * ↵ starts the session in the background (you stay where you are) and ⌘↵ / Ctrl+↵ starts and opens it: the quick
     * launch dialog. Without it, ↵ starts and opens and ⌘↵ starts in the background.
     */
    backgroundDefault?: boolean
  }>(),
  {
    project: undefined,
    autofocus: false,
    visual: false,
    backgroundDefault: false,
  },
)
const emit = defineEmits<{
  projectChange: [project: string]
  projectsChange: [projects: string[]]
  /** After the session started; `background` when you stayed put (otherwise the form routes to it next). */
  started: [session: Session, background: boolean]
}>()
const api = useApi()
// `@` file references while composing: paths in the chosen project
const searchFiles = async (query: string) =>
  (await api.searchProjectFiles(form.project, query)).matches
const router = useRouter()
const store = useProjects()
const drafts = useDrafts()
const { toast } = useToast()
const form = reactive(emptySessionForm())
const root = ref<HTMLElement | null>(null)
const models = ref<ModelInfo[]>([])
const effortOptions = computed(() => effortChoices(models.value, form.model))
watch(effortOptions, options => {
  if (!options.some(o => o.id === form.effort)) form.effort = null
})
const settings = ref<AppSettings | null>(null)
const harnesses = ref<HarnessInfo[]>([])
const loadNote = ref<string | null>(null)
const whereOpen = ref(false)
const files = ref<ChatAttachment[]>([])
const payloads = new Map<string, Attachment>()
const attachmentError = ref<string | null>(null)
const starting = ref(false)
const startError = ref<string | null>(null)
const loadingDefaults = ref(true)
const errors = ref<SessionFormErrors>({})

// ── the draft ──
// Kept in the app-wide drafts store under 'new', so it survives navigating away, and Home's composer and the quick
// launch dialog share it.
const DRAFT_KEY = 'new'
let writing = false
function restoreDraft() {
  const d = drafts.get(DRAFT_KEY)
  if (d.text !== form.prompt) form.prompt = d.text
  const ids = d.attachments.map(a => a.chip.id).join()
  if (ids !== files.value.map(f => f.id).join()) {
    for (const a of d.attachments) payloads.set(a.chip.id, a.payload)
    files.value = d.attachments.map(a => a.chip)
  }
}
function saveDraft() {
  writing = true
  try {
    drafts.set(DRAFT_KEY, {
      text: form.prompt,
      attachments: files.value.flatMap(chip => {
        const payload = payloads.get(chip.id)
        return payload ? [{ chip, payload }] : []
      }),
    })
  } finally {
    writing = false
  }
}
restoreDraft()
const stopDrafts = drafts.subscribe(DRAFT_KEY, () => {
  if (!writing) restoreDraft()
})
onBeforeUnmount(stopDrafts)
watch([() => form.prompt, files], saveDraft)

let modelRequest = 0
async function loadModels(harness: string | undefined) {
  const request = ++modelRequest
  models.value = []
  try {
    const next = await api.listModels(harness)
    if (request === modelRequest) models.value = next
  } catch {
    if (request === modelRequest)
      loadNote.value = 'Models could not be loaded. The runtime default is still available.'
  }
}

onMounted(async () => {
  const initialWorktree = form.worktree
  try {
    const response = await api.getSettings()
    harnesses.value = response.harnesses
    if (form.worktree === initialWorktree)
      form.worktree = worktreeDefault(currentProject(), response.settings)
    const remembered = lastRuntime().harness
    form.harness = response.harnesses.some(h => h.id === remembered)
      ? remembered
      : emptySessionForm(form.project, response.settings).harness
    settings.value = response.settings
  } catch {
    loadNote.value = 'Defaults could not be loaded; the runtime defaults will be used.'
    await loadModels(form.harness)
  } finally {
    loadingDefaults.value = false
    if (props.autofocus) {
      await nextTick()
      focus()
    }
  }
})

watch([() => form.harness, settings], async ([harness, defaults]) => {
  form.runtimeOptions = undefined
  if (!defaults) return
  const next = emptySessionForm(form.project, { ...defaults, defaultHarness: harness })
  const remembered = lastRuntime()
  const id = harness ?? 'claude'
  form.model = remembered.models[id] ?? next.model
  const mode = remembered.modes[id]
  const supported = harnesses.value.find(h => h.id === id)?.capabilities?.permissionModes
  form.permissionMode =
    mode && (!supported || supported.includes(mode)) ? mode : next.permissionMode
  await loadModels(harness)
})
watch(
  () => props.project,
  name => {
    if (name) {
      form.project = name
      if (!form.projects.includes(name)) form.projects.push(name)
    }
  },
  { immediate: true },
)
watch(
  () => store.projects.value,
  list => {
    if (!props.project && !form.project) {
      form.project = list.find(p => !p.missing)?.name ?? ''
      form.projects = form.project ? [form.project] : []
    }
  },
  { immediate: true },
)
watch(
  () => form.project,
  name => emit('projectChange', name),
  { immediate: true },
)
watch(
  () => [...form.projects],
  names => emit('projectsChange', names),
  { immediate: true },
)

const projectOptions = computed(() =>
  store.projects.value.filter(p => !p.missing).map(p => ({ id: p.name, label: p.title })),
)
const harnessOptions = computed(() =>
  harnesses.value.length
    ? harnesses.value.map(h => ({
        id: h.id,
        label: h.available ? h.name : `${h.name} (unavailable)`,
      }))
    : [{ id: 'claude', label: 'Claude' }],
)
const selectedHarness = computed(() => harnesses.value.find(h => h.id === form.harness))
const modeOptions = computed(() =>
  (Object.keys(PERMISSION_MODE_LABELS) as PermissionMode[])
    .filter(
      id =>
        !selectedHarness.value?.capabilities ||
        selectedHarness.value.capabilities.permissionModes.includes(id),
    )
    .map(id => ({ id, label: PERMISSION_MODE_LABELS[id] })),
)
const composerModels = computed(() => {
  const options = models.value
    .filter(m => m.value !== 'default')
    .map(m => ({ id: m.value, label: m.displayName, hint: m.description, ...pickerExtras(m) }))
  if (form.model && form.model !== 'default' && !options.some(m => m.id === form.model))
    options.unshift({ id: form.model, label: form.model, hint: 'Configured default' })
  // the runtime default stands for the first catalog entry, so it shows that entry's price and effort levels
  const first = models.value[0]
  return [
    {
      id: '',
      label: 'Default model',
      hint: 'Use the runtime default',
      ...(first ? pickerExtras(first) : {}),
    },
    ...options,
  ]
})
const placeholder = computed(() => `Message ${harnessLabel(form.harness ?? '')}…`)
const modeLabel = computed(() => PERMISSION_MODE_LABELS[form.permissionMode])
const WHERE_KEYS = 'Alt+W'
const whereKeys = keyLabel(WHERE_KEYS)
// The chosen project's own worktree default and recent branch prefixes, loaded when the project changes.
const projectDefault = ref<{ defaultWorktree?: boolean } | null>(null)
const recentPrefixes = ref<string[]>([])
function currentProject() {
  return projectDefault.value
}
let projectRequest = 0
watch(
  () => form.project,
  async name => {
    const request = ++projectRequest
    projectDefault.value = null
    recentPrefixes.value = []
    if (!name) return
    const [detail, branches] = await Promise.allSettled([
      api.getProject(name),
      api.listProjectBranches(name),
    ])
    if (request !== projectRequest) return
    if (branches.status === 'fulfilled') recentPrefixes.value = recentBranchPrefixes(branches.value)
    if (detail.status !== 'fulfilled') return
    const before = worktreeDefault(null, settings.value)
    projectDefault.value = { defaultWorktree: detail.value.settings.defaultWorktree }
    // only move the toggle if the user hasn't changed it from the default they were shown
    if (form.worktree === before)
      form.worktree = worktreeDefault(projectDefault.value, settings.value)
  },
  { immediate: true },
)
function toggleWorktree() {
  if (starting.value || loadingDefaults.value) return
  form.worktree = !form.worktree
  if (!form.worktree) form.branch = ''
  modeAnnouncement.value = form.worktree ? 'Running in a new worktree' : 'Running in this checkout'
}
let withdrawWhere: (() => void) | undefined
onMounted(() => {
  withdrawWhere = registerShortcut({
    id: 'composer-where',
    keys: WHERE_KEYS,
    label: 'Toggle new worktree for a new session',
    group: 'Sessions',
    whileTyping: true,
    inDialog: true,
    run: toggleWorktree,
  })
})
onBeforeUnmount(() => withdrawWhere?.())

// The mode chip and Shift+Tab step through the harness's modes (wrapping); the change is announced, focus stays put.
const modeAnnouncement = ref('')
function cycleMode() {
  if (starting.value) return
  const ids = modeOptions.value.map(m => m.id)
  if (!ids.length) return
  const next = ids[(ids.indexOf(form.permissionMode) + 1) % ids.length]!
  form.permissionMode = next
  modeAnnouncement.value = `Permission mode: ${PERMISSION_MODE_LABELS[next]}`
}

async function onAttach(list: File[]) {
  attachmentError.value = null
  for (const file of list) {
    const result = await readAttachment(file)
    if (!result.ok) {
      attachmentError.value = result.reason
      continue
    }
    const problem = attachmentProblem([
      ...files.value.flatMap(chip => payloads.get(chip.id) ?? []),
      result.attachment,
    ])
    if (problem) {
      attachmentError.value = problem
      continue
    }
    const id = crypto.randomUUID()
    payloads.set(id, result.attachment)
    files.value = [
      ...files.value,
      {
        id,
        name: file.name,
        size: file.size,
        kind: result.attachment.mediaType.startsWith('image/') ? 'image' : 'file',
        status: 'ready',
      },
    ]
  }
}

async function start(
  payload: { text: string; attachments: ChatAttachment[] },
  background: boolean = props.backgroundDefault,
) {
  if (starting.value || loadingDefaults.value) return
  startError.value = null
  form.prompt = payload.text
  const found = validateSessionForm(form)
  errors.value = found
  const attachments = payload.attachments
    .map(a => payloads.get(a.id))
    .filter((a): a is Attachment => !!a)
  const problem = messageProblem({ text: payload.text, attachments })
  if (problem) found.prompt = problem
  // IuComposer clears its draft after emitting. Restore only if validation or the request fails.
  starting.value = true
  await nextTick()
  if (Object.keys(found).length) {
    if (found.branch) whereOpen.value = true
    form.prompt = payload.text
    files.value = payload.attachments
    starting.value = false
    return
  }
  try {
    const request = buildStartRequest({ ...form, prompt: payload.text })
    if (attachments.length) request.prompt = { text: payload.text, attachments }
    const session = await api.startSession(request)
    rememberRuntime(form.harness ?? 'claude', {
      model: form.model,
      permissionMode: form.permissionMode,
    })
    for (const a of payload.attachments) payloads.delete(a.id)
    drafts.clear(DRAFT_KEY)
    // nothing is remembered between sends: the next composer starts from the default again
    form.worktree = worktreeDefault(currentProject(), settings.value)
    form.branch = ''
    whereOpen.value = false
    emit('started', session, background)
    if (background) {
      toast({
        title: `Started ${session.title}`,
        intent: 'success',
        action: {
          label: 'Open',
          onClick: () => void router.push({ name: 'session', params: { id: session.id } }),
        },
      })
    } else await router.push({ name: 'session', params: { id: session.id } })
  } catch (e) {
    form.prompt = payload.text
    files.value = payload.attachments
    startError.value = e instanceof Error ? e.message : String(e)
  } finally {
    starting.value = false
  }
  // Started in the background: the composer was disabled while starting, so give the caret back for the next one.
  if (background && !startError.value) {
    await nextTick()
    focus()
  }
}

const modEnter = keyLabel('Mod+Enter')

function focus() {
  root.value?.querySelector('textarea')?.focus()
}
defineExpose({ focus })
</script>

<template>
  <div ref="root" class="new-session">
    <Murmuration v-if="visual" :draft="form.prompt" :sending="starting" />
    <div class="new-session__launch-controls" aria-label="Session configuration">
      <ComposerProjects
        v-model="form.project"
        v-model:projects="form.projects"
        :options="projectOptions"
        :disabled="starting || loadingDefaults"
      />
      <ComposerChoice
        v-model="form.harness"
        label="Harness"
        :options="harnessOptions"
        :disabled="starting || loadingDefaults"
      />
    </div>
    <IuComposer
      v-model="form.prompt"
      v-model:attachments="files"
      v-model:model-id="form.model"
      :effort="form.effort"
      @update:effort="form.effort = asEffort($event ?? '')"
      :models="composerModels"
      :search-files="form.project ? searchFiles : undefined"
      :min-rows="visual ? 2 : 1"
      :placeholder="placeholder"
      :autofocus="autofocus"
      :disabled="starting || loadingDefaults"
      cycle-on-shift-tab
      alt-submit
      @submit="start($event, backgroundDefault)"
      @submit-alt="start($event, !backgroundDefault)"
      @attach="onAttach"
      @cycle="cycleMode"
    >
      <template #controls>
        <IuButton
          variant="ghost"
          size="sm"
          :aria-label="`Permission mode: ${modeLabel}. Activate to change`"
          :data-mode="form.permissionMode"
          :disabled="starting"
          @click="cycleMode"
        >
          <template #icon><IuIcon name="lock" :size="14" /></template>
          {{ modeLabel }}
        </IuButton>
        <ComposerWhere
          v-model:worktree="form.worktree"
          v-model:branch="form.branch"
          v-model:open="whereOpen"
          :prompt="form.prompt"
          :recent-prefixes="recentPrefixes"
          :shortcut="whereKeys"
          :disabled="starting || loadingDefaults"
        />
      </template>
      <template #hint-start>⇧⇥ change mode</template>
      <template #hint
        ><span v-if="starting" role="status" aria-live="polite">Starting session…</span
        ><span v-else-if="backgroundDefault"
          >↵ start in background · {{ modEnter }} start and open</span
        ><span v-else>↵ send · {{ modEnter }} in background · ⇧↵ newline</span></template
      >
    </IuComposer>
    <p v-if="errors.project" class="new-session__error" role="alert">{{ errors.project }}</p>
    <NativeControls
      :harness="form.harness ?? 'claude'"
      :project="form.project"
      :models="models"
      :model="form.model"
      :runtime-options="form.runtimeOptions"
      :disabled="starting || loadingDefaults"
      @change="form.runtimeOptions = $event"
    />
    <p v-if="errors.prompt" class="new-session__error" role="alert">{{ errors.prompt }}</p>
    <span class="sr-only" role="status" aria-live="polite">{{ modeAnnouncement }}</span>
    <IuCallout v-if="attachmentError" intent="warning" variant="inline" live>{{
      attachmentError
    }}</IuCallout>
    <IuCallout v-if="loadNote" intent="info" variant="inline">{{ loadNote }}</IuCallout>
    <IuCallout v-if="startError" intent="danger" title="Couldn't start the session" live>{{
      startError
    }}</IuCallout>
  </div>
</template>

<style>
.new-session {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.new-session__launch-controls {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.new-session__error {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-danger);
}
</style>
