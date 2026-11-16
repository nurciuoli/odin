<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { ProjectFolders } from '@odin/shared/api'
import { useRouter } from 'vue-router'
import { useApi } from '@/api'
import { useProjects } from '@/app/projects'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuCheckbox, IuField } from '@/components/Fields'
import { IuPageHeader } from '@/components/PageHeader'
import FormSection from '@/screens/shared/FormSection.vue'
import {
  buildCreateRequest,
  emptyForm,
  nameFromPath,
  needsGitInit,
  validateAddProject,
} from './addProjectForm'

const api = useApi()
const router = useRouter()
const store = useProjects()

const form = reactive(emptyForm())
const nameTouched = ref(false)
const attempted = ref(false)
const submitting = ref(false)
const submitError = ref<string | null>(null)
// shown once the server says the folder isn't a repo
const offerInit = ref(false)
const browsing = ref(false)
const folderLoading = ref(false)
const folderError = ref<string | null>(null)
const folderListing = ref<ProjectFolders | null>(null)
const folderFilter = ref('')
const visibleFolders = computed(
  () =>
    folderListing.value?.folders.filter(f =>
      f.name.toLowerCase().includes(folderFilter.value.toLowerCase()),
    ) ?? [],
)

async function browse(path?: string) {
  browsing.value = true
  folderLoading.value = true
  folderError.value = null
  try {
    folderListing.value = await api.browseProjectFolders(path)
    folderFilter.value = ''
  } catch (e) {
    folderError.value = e instanceof Error ? e.message : String(e)
  } finally {
    folderLoading.value = false
  }
}

function selectFolder() {
  if (!folderListing.value) return
  form.path = folderListing.value.path
  submitError.value = null
  browsing.value = false
}

// The name follows the folder until the user types their own.
watch(
  () => form.path,
  path => {
    if (!nameTouched.value) form.name = nameFromPath(path)
    offerInit.value = false
  },
)

const allErrors = computed(() => validateAddProject(form))
// Show an error once the field has content to judge, or after a submit attempt.
const errors = computed(() => {
  const e = allErrors.value
  const out: typeof e = {}
  if (e.path && (attempted.value || form.path.trim())) out.path = e.path
  if (e.name && (attempted.value || nameTouched.value)) out.name = e.name
  return out
})

async function submit() {
  attempted.value = true
  submitError.value = null
  if (Object.keys(allErrors.value).length) return
  submitting.value = true
  try {
    const created = await api.createProject(buildCreateRequest(form))
    await store.reload()
    await router.push({ name: 'project-overview', params: { name: created.name } })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    submitError.value = message
    if (needsGitInit(message)) offerInit.value = true
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="add-project">
    <IuPageHeader
      title="Add project"
      subtitle="Register a folder you already have. Odin never moves or deletes it."
      icon="plus"
    />

    <form class="add-project__form" novalidate @submit.prevent="submit">
      <FormSection title="Where is it?">
        <template #aside>
          <IuButton
            :disabled="folderLoading"
            :aria-expanded="browsing"
            aria-controls="project-folders"
            @click="browse(form.path.trim() || undefined)"
          >
            Browse folders
          </IuButton>
        </template>
        <section
          v-if="browsing"
          id="project-folders"
          class="add-project__browser"
          aria-label="Choose a project folder"
          :aria-busy="folderLoading"
        >
          <p class="add-project__hint">Choose a folder on the machine running Odin.</p>
          <div class="add-project__folder-actions">
            <IuButton
              :disabled="folderLoading || !folderListing?.parent"
              @click="browse(folderListing?.parent ?? undefined)"
              >Up one folder</IuButton
            >
            <IuButton :disabled="folderLoading" @click="browse()">Projects / home</IuButton>
            <IuButton variant="ghost" :disabled="folderLoading" @click="browsing = false"
              >Close browser</IuButton
            >
          </div>
          <IuCallout v-if="folderError" intent="danger" title="Couldn't open folder" live>{{
            folderError
          }}</IuCallout>
          <template v-if="folderListing">
            <p class="add-project__folder-path">{{ folderListing.path }}</p>
            <IuField
              v-model="folderFilter"
              label="Filter folders"
              placeholder="Find a folder…"
              :disabled="folderLoading"
            />
            <ul class="add-project__folders" aria-label="Folders">
              <li v-for="folder in visibleFolders" :key="folder.path">
                <IuButton variant="ghost" :disabled="folderLoading" @click="browse(folder.path)"
                  >{{ folder.name }} /</IuButton
                >
              </li>
            </ul>
            <p v-if="!visibleFolders.length" class="add-project__hint" role="status">
              {{
                folderFilter ? 'No matching folders.' : 'No subfolders. You can select this folder.'
              }}
            </p>
            <IuButton
              variant="primary"
              :disabled="folderLoading || !!folderError"
              @click="selectFolder"
              >Use this folder</IuButton
            >
          </template>
          <p v-if="folderLoading" role="status">Loading folders…</p>
        </section>
        <div class="form-grid">
          <IuField
            v-model="form.path"
            label="Path"
            mono
            placeholder="C:\Users\you\projects\my-project or /home/you/projects/my-project"
            :error="errors.path"
            :hint="
              errors.path ? undefined : 'Browse above or paste the full path to a project folder.'
            "
            class="form-span"
          />
          <IuField
            :model-value="form.name"
            label="Name (optional)"
            mono
            :error="errors.name"
            :hint="
              errors.name ? undefined : 'Used in URLs and branch names. Defaults to the folder.'
            "
            @update:model-value="
              v => {
                nameTouched = true
                form.name = String(v)
              }
            "
          />
        </div>
        <IuCheckbox
          v-if="offerInit || form.init"
          v-model="form.init"
          label="Initialise git in this folder (git init, no commit)"
        />
      </FormSection>

      <IuCallout v-if="submitError" intent="danger" title="Couldn't add the project" live>
        {{ submitError }}
      </IuCallout>

      <div class="add-project__actions">
        <IuButton as="router-link" to="/" variant="ghost">Cancel</IuButton>
        <IuButton type="submit" variant="primary" :loading="submitting">Add project</IuButton>
      </div>
    </form>
  </div>
</template>

<style>
.add-project {
  display: flex;
  flex-direction: column;
  gap: 20px;
  max-width: 760px;
}
.add-project__form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.add-project__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.add-project__browser {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
}
.add-project__folder-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.add-project__folder-path {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--iu-font-mono);
}
.add-project__hint {
  margin: 0;
  color: var(--iu-text-muted);
}
.add-project__folders {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}
</style>
