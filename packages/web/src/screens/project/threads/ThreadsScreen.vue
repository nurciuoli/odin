<script setup lang="ts">
// A project's coordinators and the threads they started (docs/plans/project-coordinator.md), plus the project brief
// and memory every coordinator and thread starts with. Threads that need the user come first.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { PROJECT_BRIEF_MAX, type ProjectBrief, type ProjectThreads } from '@odin/shared/api'
import { useApi } from '@/api'
import { useSessions } from '@/app/sessions'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCard } from '@/components/Card'
import { IuField, IuTextarea } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { useToast } from '@/components/Toast'
import { statusIntent } from '@/styles/status'
import { relativeTime, SESSION_DISPLAY } from '@/screens/shared/format'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import { useProject } from '../useProject'
import { memoryPathError, sortThreads, threadSummary } from './threads'

const api = useApi()
const router = useRouter()
const live = useSessions()
const { toast } = useToast()
const { detail } = useProject()
const name = computed(() => detail.value.name)

const threads = useResource<ProjectThreads>(() => api.listProjectThreads(name.value))
const brief = useResource<ProjectBrief>(() => api.getProjectBrief(name.value))

watch(
  name,
  () => {
    threads.reset()
    brief.reset()
    void threads.load()
    void loadBrief()
  },
  { immediate: true },
)

// Thread states change through session.updated; the sessions store bumps its revision on each.
let timer: ReturnType<typeof setTimeout> | undefined
watch(live.revision, () => {
  clearTimeout(timer)
  timer = setTimeout(() => void threads.load(), 250)
})
onBeforeUnmount(() => clearTimeout(timer))
useServerEvents(
  () => {},
  () => void threads.load(),
)

const coordinators = computed(() =>
  (threads.data.value?.coordinators ?? []).map(c => ({ ...c, threads: sortThreads(c.threads) })),
)

// ── start a coordinator ──
const prompt = ref('')
const starting = ref(false)
async function startCoordinator() {
  const text = prompt.value.trim()
  if (!text || starting.value) return
  starting.value = true
  try {
    const s = await api.startCoordinator(name.value, { prompt: { text } })
    prompt.value = ''
    await router.push({ name: 'session', params: { id: s.id } })
  } catch (err) {
    toast({
      title: "Couldn't start the coordinator",
      description: err instanceof Error ? err.message : String(err),
      intent: 'danger',
    })
  } finally {
    starting.value = false
  }
}

// ── brief ──
const briefDraft = ref('')
const savingBrief = ref(false)
async function loadBrief() {
  await brief.load()
  briefDraft.value = brief.data.value?.instructions ?? ''
}
const briefChanged = computed(() => briefDraft.value !== (brief.data.value?.instructions ?? ''))
const briefTooLong = computed(() => briefDraft.value.length > PROJECT_BRIEF_MAX)
async function saveBrief() {
  if (!briefChanged.value || briefTooLong.value) return
  savingBrief.value = true
  try {
    const next = await api.updateProjectBrief(name.value, briefDraft.value)
    brief.data.value = next
    briefDraft.value = next.instructions
    toast({ title: 'Brief saved', intent: 'success' })
  } catch (err) {
    toast({
      title: "Couldn't save the brief",
      description: err instanceof Error ? err.message : String(err),
      intent: 'danger',
    })
  } finally {
    savingBrief.value = false
  }
}

// ── memory ──
/** The file open in the editor: an existing path, or `null` path for a new file. */
const editing = ref<{ path: string | null; original: string } | null>(null)
const memoryPath = ref('')
const memoryText = ref('')
const savingMemory = ref(false)
const pathError = computed(() =>
  editing.value?.path === null ? memoryPathError(memoryPath.value) : null,
)
const memoryChanged = computed(
  () =>
    !!editing.value && (editing.value.path === null || memoryText.value !== editing.value.original),
)

async function openMemory(path: string) {
  try {
    const file = await api.readProjectMemory(name.value, path)
    editing.value = { path, original: file.content }
    memoryPath.value = path
    memoryText.value = file.content
  } catch (err) {
    toast({
      title: `Couldn't open ${path}`,
      description: err instanceof Error ? err.message : String(err),
      intent: 'danger',
    })
  }
}

function newMemory() {
  const hasIndex = brief.data.value?.memory.some(f => f.path === 'MEMORY.md')
  editing.value = { path: null, original: '' }
  memoryPath.value = hasIndex ? '' : 'MEMORY.md'
  memoryText.value = ''
}

async function saveMemory() {
  if (!editing.value || pathError.value || !memoryChanged.value) return
  const path = editing.value.path ?? memoryPath.value.trim()
  savingMemory.value = true
  try {
    brief.data.value = await api.writeProjectMemory(name.value, path, memoryText.value)
    editing.value = { path, original: memoryText.value }
    memoryPath.value = path
    toast({ title: `Saved ${path}`, intent: 'success' })
  } catch (err) {
    toast({
      title: `Couldn't save ${path}`,
      description: err instanceof Error ? err.message : String(err),
      intent: 'danger',
    })
  } finally {
    savingMemory.value = false
  }
}

const confirmDelete = ref(false)
async function deleteMemory() {
  const path = editing.value?.path
  if (!path) return
  savingMemory.value = true
  try {
    await api.deleteProjectMemory(name.value, path)
    confirmDelete.value = false
    editing.value = null
    await brief.load()
    toast({ title: `Deleted ${path}`, intent: 'success' })
  } catch (err) {
    toast({
      title: `Couldn't delete ${path}`,
      description: err instanceof Error ? err.message : String(err),
      intent: 'danger',
    })
  } finally {
    savingMemory.value = false
  }
}
</script>

<template>
  <div class="threads">
    <section aria-labelledby="threads-coordinators" class="threads__section">
      <h2 id="threads-coordinators" class="threads__heading">Coordinators</h2>
      <p class="threads__lede">
        A coordinator is a session that hands work to parallel threads, each in its own worktree,
        and hears back when they finish. Threads share this project's brief and memory.
      </p>
      <form class="threads__start" novalidate @submit.prevent="startCoordinator">
        <IuTextarea
          v-model="prompt"
          label="What should the coordinator work on?"
          hint="It decides what becomes a thread. You can keep sending it work."
          :rows="3"
        />
        <div class="threads__actions">
          <IuButton
            type="submit"
            variant="primary"
            size="sm"
            :loading="starting"
            :disabled="!prompt.trim()"
            >Start coordinator</IuButton
          >
        </div>
      </form>

      <IuSkeleton
        v-if="threads.phase.value === 'loading' && !threads.data.value"
        shape="card"
        :rows="2"
      />
      <IuErrorState
        v-else-if="threads.phase.value === 'error' && !threads.data.value"
        title="Couldn't load the threads"
        :body="threads.error.value?.message ?? 'Unknown error'"
        :trace-id="`project.threads.${threads.error.value?.status ?? 0}`"
        @retry="threads.load()"
      />
      <IuEmpty
        v-else-if="!coordinators.length"
        title="No coordinators yet"
        body="Start one above to run several threads in parallel."
      />
      <ul v-else class="threads__list" aria-label="Coordinators">
        <li v-for="c in coordinators" :key="c.session.id">
          <IuCard density="compact">
            <div class="threads__coordinator">
              <RouterLink
                :to="{ name: 'session', params: { id: c.session.id } }"
                class="threads__title"
                >{{ c.session.title }}</RouterLink
              >
              <IuBadge
                :intent="statusIntent[SESSION_DISPLAY[c.session.state].status]"
                :tempo="SESSION_DISPLAY[c.session.state].status"
                dot
                >{{ SESSION_DISPLAY[c.session.state].label }}</IuBadge
              >
              <span class="threads__meta">{{ threadSummary(c.threads) }}</span>
            </div>
            <ul
              v-if="c.threads.length"
              class="threads__rows"
              :aria-label="`Threads of ${c.session.title}`"
            >
              <li v-for="t in c.threads" :key="t.sessionId" class="threads__row">
                <IuBadge
                  :intent="statusIntent[SESSION_DISPLAY[t.session.state].status]"
                  :tempo="SESSION_DISPLAY[t.session.state].status"
                  dot
                  size="xs"
                  >{{ SESSION_DISPLAY[t.session.state].label }}</IuBadge
                >
                <RouterLink
                  :to="{ name: 'session', params: { id: t.sessionId } }"
                  class="threads__title"
                  >{{ t.session.title }}</RouterLink
                >
                <code v-if="t.session.branch" class="threads__branch">{{ t.session.branch }}</code>
                <time class="threads__meta" :datetime="t.createdAt" :title="t.createdAt">{{
                  relativeTime(t.createdAt)
                }}</time>
                <p class="threads__task">{{ t.task }}</p>
              </li>
            </ul>
          </IuCard>
        </li>
      </ul>
    </section>

    <section aria-labelledby="threads-brief" class="threads__section">
      <h2 id="threads-brief" class="threads__heading">Project brief</h2>
      <IuSkeleton
        v-if="brief.phase.value === 'loading' && !brief.data.value"
        shape="row"
        :rows="3"
      />
      <IuErrorState
        v-else-if="brief.phase.value === 'error' && !brief.data.value"
        title="Couldn't load the brief"
        :body="brief.error.value?.message ?? 'Unknown error'"
        :trace-id="`project.brief.${brief.error.value?.status ?? 0}`"
        @retry="loadBrief()"
      />
      <form v-else class="threads__form" novalidate @submit.prevent="saveBrief">
        <IuTextarea
          v-model="briefDraft"
          label="Standing rules for every coordinator and thread"
          hint="Which branch to target, how a thread checks its work, what needs your go-ahead. Reaches new threads, not running ones."
          :rows="6"
          :maxlength="PROJECT_BRIEF_MAX"
          :error="briefTooLong ? `At most ${PROJECT_BRIEF_MAX} characters` : undefined"
        />
        <div class="threads__actions">
          <IuButton
            type="submit"
            size="sm"
            :loading="savingBrief"
            :disabled="!briefChanged || briefTooLong"
            >Save brief</IuButton
          >
        </div>
      </form>
    </section>

    <section aria-labelledby="threads-memory" class="threads__section">
      <div class="threads__section-head">
        <h2 id="threads-memory" class="threads__heading">Project memory</h2>
        <IuButton size="sm" variant="ghost" @click="newMemory">New file</IuButton>
      </div>
      <p class="threads__lede">
        Notes coordinators and threads keep as they work: requirements, decisions, pitfalls.
        <code>MEMORY.md</code> is the index every new thread reads.
      </p>
      <div v-if="brief.data.value" class="threads__memory">
        <IuEmpty
          v-if="!brief.data.value.memory.length && !editing"
          title="No memory yet"
          body="Coordinators and threads add files here when you ask them to remember something."
        />
        <ul v-else class="threads__files" aria-label="Memory files">
          <li v-for="f in brief.data.value.memory" :key="f.path">
            <button
              type="button"
              class="threads__file"
              :aria-current="editing?.path === f.path ? 'true' : undefined"
              @click="openMemory(f.path)"
            >
              <span class="threads__file-path">{{ f.path }}</span>
              <time class="threads__meta" :datetime="f.updatedAt">{{
                relativeTime(f.updatedAt)
              }}</time>
            </button>
          </li>
        </ul>
        <form v-if="editing" class="threads__form" novalidate @submit.prevent="saveMemory">
          <IuField
            v-if="editing.path === null"
            :model-value="memoryPath"
            label="File"
            mono
            placeholder="decisions/database.md"
            :error="memoryPath ? (pathError ?? undefined) : undefined"
            @update:model-value="v => (memoryPath = String(v))"
          />
          <IuTextarea v-model="memoryText" :label="editing.path ?? 'Content'" mono :rows="10" />
          <div class="threads__actions">
            <IuButton
              v-if="editing.path !== null"
              variant="ghost"
              size="sm"
              @click="confirmDelete = true"
              >Delete</IuButton
            >
            <IuButton variant="ghost" size="sm" @click="editing = null">Close</IuButton>
            <IuButton
              type="submit"
              size="sm"
              :loading="savingMemory"
              :disabled="!!pathError || !memoryChanged"
              >Save</IuButton
            >
          </div>
        </form>
      </div>
    </section>

    <IuDialog v-model:open="confirmDelete" size="sm">
      <template #header>
        <h2 class="threads__dialog-title">Delete {{ editing?.path }}?</h2>
      </template>
      <p class="threads__dialog-text">
        Coordinators and threads stop seeing it. If <code>MEMORY.md</code> links to it, update the
        index too.
      </p>
      <template #footer>
        <IuButton variant="ghost" @click="confirmDelete = false">Cancel</IuButton>
        <IuButton variant="danger" :loading="savingMemory" @click="deleteMemory">Delete</IuButton>
      </template>
    </IuDialog>
  </div>
</template>

<style>
.threads {
  display: flex;
  flex-direction: column;
  gap: 28px;
  padding-top: 8px;
}
.threads__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.threads__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.threads__heading {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.threads__lede,
.threads__dialog-text {
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.threads__dialog-title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.threads__start,
.threads__form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.threads__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.threads__list,
.threads__rows,
.threads__files {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}
.threads__list {
  gap: 12px;
}
.threads__coordinator {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.threads__rows {
  gap: 10px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--iu-border);
}
.threads__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
}
.threads__title {
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.threads__title:focus-visible,
.threads__file:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
}
.threads__branch {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.threads__meta {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.threads__task {
  flex-basis: 100%;
  margin: 0;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.threads__memory {
  display: grid;
  grid-template-columns: minmax(180px, 260px) 1fr;
  gap: 16px;
  align-items: start;
}
.threads__memory > .iu-empty {
  grid-column: 1 / -1;
}
.threads__files {
  gap: 2px;
}
.threads__file {
  display: flex;
  width: 100%;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.threads__file:hover,
.threads__file[aria-current='true'] {
  background: var(--iu-surface-sunken);
}
.threads__file-path {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  overflow-wrap: anywhere;
}
@media (max-width: 720px) {
  .threads__memory {
    grid-template-columns: 1fr;
  }
}
</style>
