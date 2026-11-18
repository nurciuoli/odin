<script setup lang="ts">
// Quick launch (⌘⇧O, or `>New session` in the palette): the new-session composer in a dialog, from anywhere. Preset
// to the project you're looking at (a project page, or the open session's project). ↵ starts in the background and
// closes, so you stay where you were; ⌘↵ starts and opens the session.
import { ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '@/api'
import { IuDialog } from '@/components/Modal'
import NewSessionForm from '@/screens/shared/NewSessionForm.vue'
import { useSessions } from './sessions'

const open = defineModel<boolean>('open', { required: true })
defineProps<{ harness?: string }>()
const route = useRoute()
const api = useApi()
const sessions = useSessions()
const project = ref<string | undefined>(undefined)
const ready = ref(false)

async function currentProject(): Promise<string | undefined> {
  if (typeof route.params.name === 'string' && route.path.startsWith('/p/'))
    return route.params.name
  if (route.name !== 'session' || typeof route.params.id !== 'string') return undefined
  const id = route.params.id
  const known = [...sessions.active.value, ...sessions.sidebar.value].find(s => s.id === id)
  if (known) return known.project
  try {
    return (await api.getSession(id)).project
  } catch {
    return undefined
  }
}

// The form mounts only while the dialog is open, once the preset is known, so it opens on the right project.
watch(
  open,
  async isOpen => {
    if (!isOpen) {
      ready.value = false
      return
    }
    project.value = await currentProject()
    ready.value = open.value
  },
  { immediate: true },
)
</script>

<template>
  <IuDialog v-model:open="open" size="lg" class="quick-launch">
    <template #header>
      <h2 class="quick-launch__title">New session</h2>
    </template>
    <NewSessionForm
      v-if="ready"
      :project="project"
      :harness="harness"
      autofocus
      background-default
      @started="open = false"
    />
  </IuDialog>
</template>

<style>
.quick-launch__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
</style>
