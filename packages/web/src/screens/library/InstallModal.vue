<script setup lang="ts">
// "Install into…": pick a project and copy (or merge) the asset into it. Nothing is committed; the changed files
// show up in the project's git status. A file already there that Odin didn't write asks for a second click.
import { computed, ref, watch } from 'vue'
import type { AssetKind, InstallResult, PluginPreview } from '@odin/shared/api'
import { INSTALL_TARGETS } from '@odin/shared/library'
import { ApiRequestError, useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import SelectField from '@/screens/shared/SelectField.vue'
import { kindNoun } from './assetForm'
import PluginReview from './PluginReview.vue'

const props = withDefaults(
  defineProps<{
    kind: AssetKind
    id: string
    name: string
    /** Skip the project picker (an update from the installs list). */
    fixedProject?: string
    action?: 'install' | 'update'
  }>(),
  { fixedProject: undefined, action: 'install' },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ installed: [result: InstallResult, project: string] }>()

const api = useApi()
const projects = useProjects()
const project = ref('')
// A plugin is reviewed before it is written: its members, hooks, commands, secrets and sign-ins.
const review = ref<PluginPreview | null>(null)
const isPlugin = computed(() => props.kind === 'plugin')
const busy = ref(false)
const error = ref<string | null>(null)
const conflict = ref(false)

const options = computed(() =>
  projects.projects.value
    .filter(p => !p.missing)
    .map(p => ({ id: p.name, label: p.title || p.name })),
)
const target = computed(() => INSTALL_TARGETS[props.kind])

watch(
  open,
  isOpen => {
    if (!isOpen) return
    project.value = props.fixedProject ?? (options.value.length === 1 ? options.value[0]!.id : '')
    review.value = null
    error.value = null
    conflict.value = false
  },
  { immediate: true },
)

async function preview() {
  if (!project.value || busy.value) return
  busy.value = true
  error.value = null
  try {
    review.value = (
      await api.install(project.value, { kind: props.kind, id: props.id, action: 'preview' })
    ).preview!
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function install(force = false) {
  if (!project.value || busy.value || (isPlugin.value && !review.value)) return
  busy.value = true
  error.value = null
  try {
    const result = await api.install(project.value, {
      kind: props.kind,
      id: props.id,
      action: props.action,
      ...(review.value?.confirm ? { confirm: review.value.confirm } : {}),
      ...(force ? { force: true } : {}),
    })
    open.value = false
    emit('installed', result, project.value)
  } catch (e) {
    conflict.value = e instanceof ApiRequestError && e.status === 409
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" :size="review ? 'lg' : 'md'">
    <template #header>
      <h2 class="install-modal__title">
        {{ action === 'update' ? 'Update' : 'Install' }} “{{ name }}”{{
          fixedProject ? ` in ${fixedProject}` : ' into a project'
        }}
      </h2>
    </template>
    <form class="install-modal__form" @submit.prevent="install(false)">
      <p class="install-modal__note">
        <template v-if="target?.mode === 'merge'"
          >Odin merges this {{ kindNoun(kind) }} into <code>{{ target.target }}</code
          >, touching only what it adds.</template
        >
        <template v-else-if="target?.mode === 'bundle'"
          >Odin installs each part of this plugin the way it installs that kind alone. Review what
          it adds first.</template
        >
        <template v-else-if="target"
          >Odin copies it to <code>{{ target.target }}/</code>. Nothing is committed.</template
        >
      </p>
      <SelectField
        v-if="!fixedProject && !review"
        v-model="project"
        label="Project"
        :options="options"
        placeholder="Choose a project"
      />
      <PluginReview
        v-if="review"
        :members="review.members"
        :runs="review.runs"
        :secrets="review.secrets"
        :oauth="review.oauth"
        :missing="review.missing"
      />
      <IuCallout v-if="error" :intent="conflict ? 'warning' : 'danger'" variant="inline" live>
        {{ error }}
      </IuCallout>
    </form>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="busy" @click="open = false"
        >Cancel</IuButton
      >
      <IuButton v-if="conflict" variant="danger" size="sm" :loading="busy" @click="install(true)"
        >Overwrite</IuButton
      >
      <IuButton
        v-else-if="isPlugin && !review"
        variant="primary"
        size="sm"
        :loading="busy"
        :disabled="!project"
        @click="preview"
        >Review</IuButton
      >
      <IuButton
        v-else
        variant="primary"
        size="sm"
        :loading="busy"
        :disabled="!project || !!review?.missing.length"
        @click="install(false)"
        >{{ action === 'update' ? 'Update' : 'Install' }}</IuButton
      >
    </template>
  </IuDialog>
</template>

<style>
.install-modal__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.install-modal__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.install-modal__note {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
</style>
