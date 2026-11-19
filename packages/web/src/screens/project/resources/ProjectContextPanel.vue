<script setup lang="ts">
// Global library context and the files this project already has. Project files win; globals can be turned off.
import { computed, ref, watch } from 'vue'
import type {
  AgentContextItem,
  AgentContextKind,
  AssetFiles,
  ProjectAgentContext,
} from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import { useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField, IuSwitch, IuTextarea } from '@/components/Fields'
import { IuIcon } from '@/components/Icon'
import { IuDialog } from '@/components/Modal'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'
import { useToast } from '@/components/Toast'
import { useResource, useServerEvents } from '@/screens/shared/useResource'
import { useProject } from '../useProject'

const KIND_LABEL: Record<AgentContextKind, string> = {
  instruction: 'Instructions',
  skill: 'Skill',
  agent: 'Agent',
  mcp: 'MCP server',
  settings: 'Settings',
}

const KINDS = Object.keys(KIND_LABEL) as AgentContextKind[]

const api = useApi()
const { toast } = useToast()
const { detail } = useProject()
const name = computed(() => detail.value.name)

const res = useResource<ProjectAgentContext>(() => api.getAgentContext(name.value))
watch(name, () => (res.reset(), void res.load()), { immediate: true })

function onEvent(e: ServerEvent) {
  if (e.type === 'library.updated' || (e.type === 'project.updated' && e.project === name.value))
    void res.load()
}
useServerEvents(onEvent, () => void res.load())

const globalRows = computed(() => res.data.value?.global ?? [])
const projectRows = computed(() => res.data.value?.project ?? [])

const busy = ref<string | null>(null)
function keyOf(item: AgentContextItem) {
  return `${item.origin}/${item.kind}/${item.id}/${item.path ?? ''}`
}

async function toggle(item: AgentContextItem, enabled: boolean) {
  const key = keyOf(item)
  busy.value = key
  try {
    res.data.value = await api.setAgentContextEnabled(name.value, {
      kind: item.kind,
      id: item.id,
      enabled,
    })
  } catch (e) {
    toast({
      title: "Couldn't update that",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    busy.value = null
  }
}

const editorOpen = ref(false)
const editor = ref<{
  kind: AgentContextKind
  id: string
  entry: string
  files: AssetFiles
  creating: boolean
} | null>(null)
const draftId = ref('')
const draft = ref('')
const editorError = ref('')

function entryFor(kind: AgentContextKind, id: string): string {
  if (kind === 'skill') return 'SKILL.md'
  if (kind === 'agent') return `${id}.md`
  if (kind === 'mcp') return `${id}.json`
  if (kind === 'settings' && (id === 'claude-settings' || id === 'claude-settings-local'))
    return 'settings.json'
  if (kind === 'settings') return `${id}.json`
  return id === 'claude-md' ? 'CLAUDE.md' : 'AGENTS.md'
}

function starter(kind: AgentContextKind, id: string): string {
  if (kind === 'skill') return `---\nname: ${id}\ndescription: \n---\n\n`
  if (kind === 'agent') return `---\nname: ${id}\ndescription: \n---\n\n`
  if (kind === 'mcp') return `{\n  "command": ""\n}\n`
  if (kind === 'settings') return `{\n  "permissions": { "allow": [] }\n}\n`
  return ''
}

function add(kind: AgentContextKind) {
  editorError.value = ''
  draftId.value = ''
  draft.value = starter(kind, 'name')
  editor.value = { kind, id: '', entry: entryFor(kind, 'name'), files: {}, creating: true }
  editorOpen.value = true
}

async function edit(item: AgentContextItem) {
  editorError.value = ''
  busy.value = keyOf(item)
  try {
    const files = await api.getAgentContextFiles(name.value, item.kind, item.id)
    editor.value = {
      kind: item.kind,
      id: item.id,
      entry: files.entry,
      files: files.files,
      creating: false,
    }
    draftId.value = item.id
    draft.value = files.files[files.entry] ?? ''
    editorOpen.value = true
  } catch (e) {
    toast({
      title: "Couldn't open that file",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    busy.value = null
  }
}

async function saveEditor() {
  const current = editor.value
  if (!current) return
  const id = (current.creating ? draftId.value : current.id).trim()
  if (!id) {
    editorError.value = 'An id is required.'
    return
  }
  const entry = current.creating ? entryFor(current.kind, id) : current.entry
  const files = { ...current.files, [entry]: draft.value }
  editorError.value = ''
  busy.value = 'editor'
  try {
    res.data.value = await api.writeAgentContext(name.value, current.kind, id, files)
    editorOpen.value = false
    toast({ title: current.creating ? 'Added to this project' : 'Saved', intent: 'success' })
  } catch (e) {
    editorError.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = null
  }
}

const removing = ref<AgentContextItem | null>(null)
async function confirmRemove() {
  const item = removing.value
  if (!item) return
  removing.value = null
  busy.value = keyOf(item)
  try {
    res.data.value = await api.deleteAgentContext(name.value, item.kind, item.id)
    toast({
      title: 'Removed from this project',
      description: 'The file is gone. Nothing is committed.',
      intent: 'success',
    })
  } catch (e) {
    toast({
      title: "Couldn't remove that",
      description: e instanceof Error ? e.message : String(e),
      intent: 'danger',
    })
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="agent-context">
    <p class="agent-context__note">
      Global library context applies here, and files already in this project are included too. A
      project file wins when both use the same name.
    </p>

    <IuSkeleton v-if="res.phase.value === 'loading'" shape="card" :rows="3" />
    <IuErrorState
      v-else-if="res.phase.value === 'error'"
      title="Couldn't load agent context"
      :body="res.error.value?.message ?? 'Unknown error'"
      :trace-id="`project.context.${res.error.value?.status ?? 0}`"
      @retry="res.load()"
    />
    <template v-else>
      <section aria-labelledby="agent-context-project">
        <div class="agent-context__bar">
          <h3 id="agent-context-project" class="agent-context__heading">This project</h3>
          <div class="agent-context__adds" role="group" aria-label="Add project context">
            <IuButton
              v-for="kind in KINDS"
              :key="kind"
              size="sm"
              variant="secondary"
              @click="add(kind)"
            >
              <template #icon><IuIcon name="plus" :size="14" /></template>
              {{ KIND_LABEL[kind] }}
            </IuButton>
          </div>
        </div>
        <IuEmpty
          v-if="!projectRows.length"
          title="No project files yet"
          body="Skills, MCP servers, subagents, instructions and settings found in this repo show up here. Add one to write it into the project."
        />
        <ul v-else class="resources__list" aria-label="Project context">
          <li v-for="item in projectRows" :key="keyOf(item)" class="resources__row">
            <span class="resources__name">{{ item.name }}</span>
            <IuBadge variant="tag" size="xs">{{ KIND_LABEL[item.kind] }}</IuBadge>
            <IuBadge v-if="item.error" intent="warning">Problem</IuBadge>
            <p class="resources__text">{{ item.error ?? item.description }}</p>
            <code v-if="item.path" class="resources__code">{{ item.path }}</code>
            <div class="agent-context__actions">
              <IuButton
                size="sm"
                variant="secondary"
                :disabled="busy === keyOf(item)"
                @click="edit(item)"
                >Edit</IuButton
              >
              <IuButton
                size="sm"
                variant="ghost"
                :disabled="busy === keyOf(item)"
                @click="removing = item"
                >Remove</IuButton
              >
            </div>
          </li>
        </ul>
      </section>

      <section aria-labelledby="agent-context-global">
        <h3 id="agent-context-global" class="agent-context__heading">Global</h3>
        <IuEmpty
          v-if="!globalRows.length"
          title="Nothing in the library"
          body="Skills, MCP servers, subagents, instructions and settings in the library apply to every project until you turn one off here."
        />
        <ul v-else class="resources__list" aria-label="Global context">
          <li v-for="item in globalRows" :key="keyOf(item)" class="resources__row">
            <span class="resources__name">{{ item.name }}</span>
            <IuBadge variant="tag" size="xs">{{ KIND_LABEL[item.kind] }}</IuBadge>
            <IuBadge v-if="item.overridden" intent="info">Project copy wins</IuBadge>
            <IuBadge v-if="!item.libraryEnabled" intent="neutral">Off in the library</IuBadge>
            <IuBadge v-if="item.error" intent="warning">Problem</IuBadge>
            <p class="resources__text">{{ item.error ?? item.description }}</p>
            <IuSwitch
              :model-value="item.enabled"
              :disabled="!item.libraryEnabled || busy === keyOf(item)"
              size="sm"
              :label="`Use ${item.name} in this project`"
              @update:model-value="toggle(item, $event)"
            />
          </li>
        </ul>
      </section>
    </template>

    <IuDialog v-model:open="editorOpen" size="md">
      <template #header>
        <h2 class="agent-context__title">
          {{ editor?.creating ? 'Add' : 'Edit' }} {{ editor ? KIND_LABEL[editor.kind] : '' }}
        </h2>
      </template>
      <div v-if="editor" class="agent-context__form">
        <IuField v-if="editor.creating" v-model="draftId" label="Id" mono placeholder="ship" />
        <IuTextarea
          v-model="draft"
          :label="editor.creating ? entryFor(editor.kind, draftId || 'name') : editor.entry"
          mono
          :rows="12"
        />
        <IuCallout v-if="editorError" intent="danger">{{ editorError }}</IuCallout>
      </div>
      <template #footer>
        <IuButton variant="ghost" size="sm" @click="editorOpen = false">Cancel</IuButton>
        <IuButton variant="primary" size="sm" :loading="busy === 'editor'" @click="saveEditor"
          >Save</IuButton
        >
      </template>
    </IuDialog>

    <IuDialog
      :open="removing !== null"
      size="sm"
      @update:open="
        open => {
          if (!open) removing = null
        }
      "
    >
      <template #header>
        <h2 class="agent-context__title">Remove {{ removing?.name }}?</h2>
      </template>
      <p class="resources__text">
        This deletes the project file. The global library copy is left as it is. Nothing is
        committed.
      </p>
      <template #footer>
        <IuButton variant="ghost" size="sm" @click="removing = null">Cancel</IuButton>
        <IuButton variant="danger" size="sm" @click="confirmRemove">Remove</IuButton>
      </template>
    </IuDialog>
  </div>
</template>

<style scoped>
.agent-context {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.agent-context__note {
  margin: 0;
  font-size: var(--iu-font-size-12-5);
  color: var(--iu-text-muted);
}
.agent-context__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 12px;
}
.agent-context__heading {
  margin: 0;
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-semibold);
}
.agent-context__adds {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.agent-context__actions {
  display: flex;
  flex-basis: 100%;
  gap: 6px;
}
.agent-context__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.agent-context__form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
