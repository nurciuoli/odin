<script setup lang="ts">
// New project (⌘K → "New project…", the sidebar +, the Projects page). Name first; the location is a chip you can
// change; one of three ways to start: a new folder, a folder you already have, or a clone. Mounted once in App.vue.
import { computed, nextTick, reactive, ref, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { ProjectFolders } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuCheckbox, IuField } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuDialog } from '@/components/Modal'
import { IuSegmented } from '@/components/Segmented'
import {
  buildNewProjectRequest,
  effectiveName,
  emptyNewProject,
  plan,
  recentParents,
  targetPath,
  validateNewProject,
  type NewProjectMode,
} from '@/screens/projects/newProjectForm'
import { newProjectMode, newProjectOpen } from './newProject'
import { useProjects } from './projects'
import { keyLabel } from './shortcuts'

const api = useApi()
const router = useRouter()
const store = useProjects()

const form = reactive(emptyNewProject())
const attempted = ref(false)
const submitting = ref(false)
const submitError = ref<string | null>(null)
const root = useTemplateRef<HTMLElement>('root')

// ── where it goes: the folders your projects already sit in, plus the server's starting folder ──
const fallback = ref('')
const places = computed(() => {
  const list = recentParents(store.projects.value.map(p => p.path))
  if (fallback.value && !list.includes(fallback.value)) list.push(fallback.value)
  return list.slice(0, 4)
})
const baseName = (p: string) =>
  p
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || p

// ── the folder browser, for "other…" and for picking an existing folder ──
const browsing = ref(false)
const listing = ref<ProjectFolders | null>(null)
const browseError = ref<string | null>(null)
const browseLoading = ref(false)
const filter = ref('')
const shown = computed(
  () =>
    listing.value?.folders.filter(f => f.name.toLowerCase().includes(filter.value.toLowerCase())) ??
    [],
)
async function browse(path?: string) {
  browsing.value = true
  browseLoading.value = true
  browseError.value = null
  try {
    listing.value = await api.browseProjectFolders(path)
    filter.value = ''
  } catch (e) {
    browseError.value = e instanceof Error ? e.message : String(e)
  } finally {
    browseLoading.value = false
  }
}
function openBrowser() {
  const from = form.mode === 'existing' ? form.path.trim() : form.parent
  void browse(from || undefined)
}
function useListed() {
  if (!listing.value) return
  if (form.mode === 'existing') form.path = listing.value.path
  else form.parent = listing.value.path
  browsing.value = false
}

// ── open / reset ──
watch(newProjectOpen, async open => {
  if (!open) return
  Object.assign(form, emptyNewProject(newProjectMode.value, places.value[0] ?? ''))
  attempted.value = false
  submitError.value = null
  browsing.value = false
  if (!fallback.value) {
    try {
      fallback.value = (await api.browseProjectFolders()).path
    } catch {
      // no starting folder: the user types or browses
    }
  }
  if (!form.parent) form.parent = places.value[0] ?? ''
  await nextTick()
  focusFirst()
})
function focusFirst() {
  root.value?.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')?.focus()
}
watch(
  () => form.mode,
  async () => {
    submitError.value = null
    await nextTick()
    focusFirst()
  },
)

const modes: { value: NewProjectMode; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'existing', label: 'Existing' },
  { value: 'clone', label: 'Clone' },
]
const errors = computed(() => validateNewProject(form))
const shownErrors = computed(() => (attempted.value ? errors.value : {}))
const steps = computed(() => plan(form))
const path = computed(() => targetPath(form))
const nameHint = computed(() =>
  form.mode === 'existing' && !form.name.trim() ? effectiveName(form) : '',
)

async function submit() {
  attempted.value = true
  submitError.value = null
  if (Object.keys(errors.value).length) return
  submitting.value = true
  try {
    const created = await api.createProject(buildNewProjectRequest(form))
    await store.reload()
    newProjectOpen.value = false
    await router.push({ name: 'project-overview', params: { name: created.name } })
  } catch (e) {
    submitError.value = e instanceof Error ? e.message : String(e)
  } finally {
    submitting.value = false
  }
}
function onKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
    e.preventDefault()
    openBrowser()
  }
}
const createLabel = computed(() =>
  form.mode === 'clone' ? 'Clone' : form.mode === 'existing' ? 'Add' : 'Create',
)
</script>

<template>
  <IuDialog v-model:open="newProjectOpen" size="lg">
    <template #header>
      <div class="np__head">
        <h2 class="np__title">New project</h2>
        <IuSegmented v-model="form.mode" :options="modes" label="How to start" />
      </div>
    </template>

    <form ref="root" class="np" novalidate @submit.prevent="submit" @keydown="onKeydown">
      <IuField
        v-if="form.mode === 'clone'"
        v-model="form.source"
        label="Repository"
        placeholder="owner/name or a git URL"
        mono
        :error="shownErrors.source"
      />

      <IuField
        v-if="form.mode === 'existing'"
        v-model="form.path"
        label="Folder"
        placeholder="/home/you/code/my-app"
        mono
        :error="shownErrors.path"
      />
      <div v-if="form.mode === 'existing'" class="np__row">
        <IuButton size="sm" type="button" @click="openBrowser">
          Browse… <kbd class="np__kbd">{{ keyLabel('Mod+L') }}</kbd>
        </IuButton>
      </div>

      <IuField
        v-model="form.name"
        :label="form.mode === 'existing' ? 'Name (optional)' : 'Name'"
        :placeholder="
          form.mode === 'clone' ? effectiveName(form) || 'from the repository' : 'my-project'
        "
        :hint="nameHint ? `Defaults to ${nameHint}` : undefined"
        mono
        :error="shownErrors.name"
      />

      <div v-if="form.mode !== 'existing'" class="np__where">
        <span class="np__label">{{ form.mode === 'clone' ? 'Clone into' : 'Create in' }}</span>
        <div class="np__chips" role="radiogroup" aria-label="Location">
          <button
            v-for="p in places"
            :key="p"
            type="button"
            class="np__chip"
            role="radio"
            :aria-checked="form.parent === p"
            :title="p"
            @click="(form.parent = p), (browsing = false)"
          >
            <IuIcon name="folder" :size="14" />{{ baseName(p) }}
          </button>
          <button type="button" class="np__chip np__chip--other" @click="openBrowser">
            <IuIcon name="plus" :size="14" />other…
            <kbd class="np__kbd">{{ keyLabel('Mod+L') }}</kbd>
          </button>
        </div>
        <p v-if="shownErrors.parent" class="np__error" role="alert">{{ shownErrors.parent }}</p>
      </div>

      <section
        v-if="browsing"
        class="np__browser"
        aria-label="Choose a folder"
        :aria-busy="browseLoading"
      >
        <div class="np__browser-bar">
          <IuButton
            size="sm"
            variant="ghost"
            type="button"
            :disabled="browseLoading || !listing?.parent"
            aria-label="Up one folder"
            @click="browse(listing?.parent ?? undefined)"
          >
            <template #icon><IuIcon name="arrowUp" :size="14" /></template>
          </IuButton>
          <code class="np__browser-path">{{ listing?.path ?? '…' }}</code>
          <IuField
            v-model="filter"
            label="Filter folders"
            hide-label
            placeholder="Filter"
            size="sm"
          />
        </div>
        <IuCallout v-if="browseError" intent="danger" variant="inline" live>{{
          browseError
        }}</IuCallout>
        <ul class="np__folders" aria-label="Folders">
          <li v-for="f in shown" :key="f.path">
            <button type="button" class="np__folder" @click="browse(f.path)">
              <IuIcon name="folder" :size="14" />{{ f.name }}
            </button>
          </li>
          <li v-if="!shown.length && !browseLoading" class="np__none">
            {{ filter ? 'No matching folders.' : 'No subfolders.' }}
          </li>
        </ul>
        <div class="np__browser-foot">
          <IuButton size="sm" variant="ghost" type="button" @click="browsing = false"
            >Close</IuButton
          >
          <IuButton size="sm" type="button" :disabled="!listing" @click="useListed"
            >Use this folder</IuButton
          >
        </div>
      </section>

      <p v-if="path" class="np__path" :title="path">{{ path }}</p>

      <div class="np__opts">
        <IuCheckbox v-if="form.mode !== 'clone'" v-model="form.init" label="git init" />
        <IuCheckbox v-if="form.mode === 'new'" v-model="form.readme" label="README" />
      </div>
      <ul v-if="steps.length" class="np__plan" aria-label="What will happen">
        <li v-for="s in steps" :key="s">{{ s }}</li>
      </ul>

      <IuCallout v-if="submitError" intent="danger" title="Couldn't create the project" live>
        {{ submitError }}
      </IuCallout>
    </form>

    <template #footer>
      <span class="np__hint"
        >Odin never moves or deletes your folders.
        <kbd class="np__kbd">{{ keyLabel('Mod+Alt+N') }}</kbd> opens this anywhere.</span
      >
      <IuButton variant="ghost" type="button" @click="newProjectOpen = false">Cancel</IuButton>
      <IuButton variant="primary" :loading="submitting" @click="submit">
        {{ createLabel }} <kbd class="np__kbd">⏎</kbd>
      </IuButton>
    </template>
  </IuDialog>
</template>

<style>
.np__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
}
.np__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.np {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 16px;
}
.np__row,
.np__opts {
  display: flex;
  align-items: center;
  gap: 18px;
}
.np__where {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.np__label {
  font-size: var(--iu-font-size-12);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-2);
}
.np__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.np__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-pill);
  background: none;
  color: var(--iu-text-2);
  font: inherit;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  cursor: pointer;
}
.np__chip:hover {
  border-color: var(--iu-border-strong);
}
.np__chip[aria-checked='true'] {
  border-color: var(--iu-border-strong);
  background: var(--iu-surface-raised);
  color: var(--iu-text);
}
.np__chip:focus-visible,
.np__folder:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 1px;
}
.np__kbd {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
.np__path {
  margin: 0;
  overflow-wrap: anywhere;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.np__plan {
  margin: 0;
  padding: 0;
  list-style: none;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.np__plan li::before {
  content: '· ';
  color: var(--iu-text-muted);
}
.np__error {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-danger, var(--iu-text));
}
.np__hint {
  flex: 1;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.np__browser {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  background: var(--iu-surface-sunken);
}
.np__browser-bar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.np__browser-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.np__folders {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 180px;
  overflow-y: auto;
}
.np__folder {
  display: flex;
  align-items: center;
  gap: 8px;
  inline-size: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: none;
  color: var(--iu-text-2);
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.np__folder:hover {
  background: var(--iu-surface-raised);
  color: var(--iu-text);
}
.np__none {
  padding: 6px 8px;
  color: var(--iu-text-muted);
}
.np__browser-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
