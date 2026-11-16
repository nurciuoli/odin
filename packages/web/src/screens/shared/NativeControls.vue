<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ModelInfo,
  NativeCatalog,
  NativePermissionRule,
  NativeSessionAction,
  NativeSessionState,
  RuntimeOptions,
  Session,
} from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuField } from '@/components/Fields'
import { IuCodeBlock } from '@/components/CodeBlock'
import { IuMarkdown } from '@/components/Markdown'
import ComposerChoice from './ComposerChoice.vue'

const props = withDefaults(
  defineProps<{
    harness: string
    project: string
    models: ModelInfo[]
    model: string | null
    runtimeOptions?: RuntimeOptions
    sessionId?: string
    disabled?: boolean
  }>(),
  { runtimeOptions: undefined, sessionId: undefined, disabled: false },
)
const emit = defineEmits<{
  change: [options: RuntimeOptions]
  updated: [session: Session]
  history: []
}>()
const api = useApi()
const open = ref(false)
const catalog = ref<NativeCatalog | null>(null)
const state = ref<NativeSessionState | null>(null)
const error = ref('')
const busy = ref(false)
const agent = ref('')
const variant = ref('')
const rules = ref<NativePermissionRule[]>([])
const agentEdited = ref(false)
const variantEdited = ref(false)
const rulesEdited = ref(false)
const messageId = ref('')
const command = ref('')
const argumentsText = ref('')
const shell = ref('')
const announcement = ref('')
const actions = ref<NativeSessionAction['type'][]>([])
const refresh = ref(0)
const allowed = (type: NativeSessionAction['type']) => actions.value.includes(type)
watch(
  () => props.runtimeOptions,
  value => {
    agent.value = value?.agent ?? ''
    variant.value = value?.variant ?? ''
    rules.value = (value?.permissionRules ?? []).map(rule => ({ ...rule }))
    agentEdited.value = false
    variantEdited.value = false
    rulesEdited.value = false
  },
  { immediate: true, deep: true },
)
const agentOptions = computed(() => [
  { id: '', label: 'Default agent' },
  ...(catalog.value?.agents ?? [])
    .filter(a => a.mode !== 'subagent' && !a.hidden)
    .map(a => ({ id: a.name, label: a.name })),
])
const variantOptions = computed(() => [
  { id: '', label: 'Default variant' },
  ...(props.models.find(m => m.value === props.model)?.variants ?? []).map(id => ({
    id,
    label: id,
  })),
])
const revertOptions = computed(() =>
  (state.value?.context ?? [])
    .filter(entry => entry.kind === 'user')
    .map(entry => ({
      id: entry.id,
      label: entry.kind === 'user' ? entry.text.slice(0, 100) : entry.id,
    })),
)
let request = 0
watch(
  () => [props.harness, props.project, props.sessionId, open.value, refresh.value],
  async () => {
    const current = ++request
    catalog.value = null
    if (props.harness !== 'opencode' || !props.project || !open.value) return
    error.value = ''
    try {
      const [next, native, settings] = await Promise.all([
        api.getNativeCatalog(props.harness, props.project),
        props.sessionId ? api.getSessionNativeState(props.sessionId) : Promise.resolve(null),
        api.getSettings(),
      ])
      if (current === request) {
        catalog.value = next
        state.value = native
        actions.value =
          settings.harnesses.find(h => h.id === props.harness)?.capabilities?.native?.actions ?? []
      }
    } catch (e) {
      if (current === request)
        error.value = e instanceof Error ? e.message : 'OpenCode controls could not be loaded.'
    }
  },
  { immediate: true },
)
function options(): RuntimeOptions {
  return {
    ...props.runtimeOptions,
    ...(agentEdited.value ? { agent: agent.value || null } : {}),
    ...(variantEdited.value ? { variant: variant.value || null } : {}),
    ...(rulesEdited.value ? { permissionRules: rules.value.map(r => ({ ...r })) } : {}),
  }
}
function changed() {
  if (!props.sessionId) emit('change', options())
}
function editRules() {
  rulesEdited.value = true
  changed()
}
function editAgent() {
  agentEdited.value = true
  changed()
}
function editVariant() {
  variantEdited.value = true
  changed()
}
function addRule() {
  rules.value.push({ action: 'edit', resource: '*', effect: 'ask' })
  editRules()
}
function removeRule(index: number) {
  rules.value.splice(index, 1)
  editRules()
}
async function apply() {
  if (!props.sessionId) return
  busy.value = true
  error.value = ''
  announcement.value = ''
  try {
    emit('updated', await api.updateSession(props.sessionId, { runtimeOptions: options() }))
    announcement.value = 'OpenCode settings saved.'
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Settings could not be saved.'
  } finally {
    busy.value = false
  }
}
async function act(action: NativeSessionAction) {
  if (!props.sessionId || !allowed(action.type)) return
  busy.value = true
  error.value = ''
  announcement.value = ''
  try {
    state.value = await api.sessionNativeAction(props.sessionId, action)
    announcement.value = 'OpenCode action accepted.'
    if (action.type === 'revert' || action.type === 'unrevert' || action.type === 'commitRevert')
      emit('history')
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'OpenCode action failed.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="harness === 'opencode'" class="native-controls">
    <IuButton variant="ghost" size="sm" :aria-expanded="open" @click="open = !open"
      >OpenCode controls</IuButton
    >
    <div v-if="open" class="native-controls__body">
      <p v-if="error" role="alert">{{ error }}</p>
      <p role="status" aria-live="polite">{{ announcement }}</p>
      <template v-if="catalog">
        <IuButton variant="ghost" size="sm" :disabled="busy" @click="refresh++"
          >Refresh native configuration</IuButton
        >
        <ComposerChoice
          v-model="agent"
          label="Native agent"
          :options="agentOptions"
          :disabled="disabled || busy"
          @update:model-value="editAgent"
        />
        <ComposerChoice
          v-model="variant"
          label="Model variant"
          :options="variantOptions"
          :disabled="disabled || busy"
          @update:model-value="editVariant"
        />
        <p>Permission rules apply in order. Later matching rules take precedence.</p>
        <div v-for="(rule, index) in rules" :key="index" class="native-controls__rule">
          <IuField
            v-model="rule.action"
            :label="`Rule ${index + 1} action`"
            :disabled="disabled || busy"
            @update:model-value="editRules"
          />
          <IuField
            v-model="rule.resource"
            :label="`Rule ${index + 1} resource`"
            :disabled="disabled || busy"
            @update:model-value="editRules"
          />
          <ComposerChoice
            v-model="rule.effect"
            :label="`Rule ${index + 1} effect`"
            :options="[
              { id: 'ask', label: 'Ask' },
              { id: 'allow', label: 'Allow' },
              { id: 'deny', label: 'Deny' },
            ]"
            :disabled="disabled || busy"
            @update:model-value="editRules"
          />
          <IuButton
            variant="ghost"
            size="sm"
            :disabled="disabled || busy"
            :aria-label="`Remove rule ${index + 1}`"
            @click="removeRule(index)"
            >Remove</IuButton
          >
        </div>
        <IuButton variant="secondary" size="sm" :disabled="disabled || busy" @click="addRule"
          >Add permission rule</IuButton
        >
        <IuButton v-if="sessionId" size="sm" :disabled="disabled || busy" @click="apply"
          >Apply OpenCode settings</IuButton
        >
        <template v-if="sessionId">
          <IuButton
            variant="secondary"
            size="sm"
            :disabled="disabled || busy"
            v-if="allowed('compact')"
            @click="act({ type: 'compact' })"
            >Compact context</IuButton
          >
          <ComposerChoice
            v-if="revertOptions.length"
            v-model="messageId"
            label="Revert before prompt"
            :options="[{ id: '', label: 'Choose a prompt' }, ...revertOptions]"
            :disabled="disabled || busy"
          />
          <IuField
            v-else
            v-model="messageId"
            label="Revert before message ID"
            :disabled="disabled || busy"
          />
          <IuButton
            variant="secondary"
            size="sm"
            :disabled="disabled || busy || !messageId.trim()"
            v-if="allowed('revert')"
            @click="act({ type: 'revert', messageId: messageId.trim() })"
            >Stage revert</IuButton
          >
          <template v-if="state?.revert">
            <p>Revert staged before {{ state.revert.messageId }}.</p>
            <IuButton
              variant="secondary"
              size="sm"
              :disabled="disabled || busy"
              v-if="allowed('unrevert')"
              @click="act({ type: 'unrevert' })"
              >Undo staged revert</IuButton
            >
            <IuButton
              variant="secondary"
              size="sm"
              :disabled="disabled || busy"
              v-if="allowed('commitRevert')"
              @click="act({ type: 'commitRevert' })"
              >Commit staged revert</IuButton
            >
          </template>
          <ComposerChoice
            v-model="command"
            label="Native command"
            :options="[
              { id: '', label: 'Choose command' },
              ...catalog.commands.map(c => ({ id: c.name, label: c.name })),
            ]"
            :disabled="disabled || busy"
          />
          <IuField v-model="argumentsText" label="Command arguments" :disabled="disabled || busy" />
          <IuButton
            variant="secondary"
            size="sm"
            :disabled="disabled || busy || !command"
            v-if="allowed('command')"
            @click="act({ type: 'command', name: command, arguments: argumentsText })"
            >Run command</IuButton
          >
          <IuField v-model="shell" label="Shell command" :disabled="disabled || busy" />
          <IuButton
            variant="secondary"
            size="sm"
            :disabled="disabled || busy || !shell.trim()"
            v-if="allowed('shell')"
            @click="act({ type: 'shell', command: shell.trim() })"
            >Run shell command</IuButton
          >
        </template>
        <details>
          <summary>Native configuration</summary>
          <p v-for="provider in catalog.providers" :key="provider.id">
            {{ provider.name }} · {{ provider.enabled ? 'Enabled' : 'Disabled' }}
          </p>
          <p v-for="server in catalog.mcp" :key="server.name">
            MCP: {{ server.name }} · {{ server.status }}
          </p>
          <p v-for="skill in catalog.skills" :key="skill.name">
            Skill: {{ skill.name }} · {{ skill.description }}
          </p>
          <div v-for="plugin in catalog.plugins" :key="plugin">
            <p>Plugin: {{ plugin }}</p>
            <IuButton
              v-if="
                sessionId && allowed('updatePlugins') && catalog.updatablePlugins?.includes(plugin)
              "
              variant="secondary"
              size="sm"
              :disabled="disabled || busy"
              @click="act({ type: 'updatePlugins', targets: [plugin] })"
              >Update {{ plugin }}</IuButton
            >
          </div>
          <IuButton
            v-if="sessionId && allowed('reload')"
            variant="secondary"
            size="sm"
            :disabled="disabled || busy"
            @click="act({ type: 'reload' })"
            >Reload native configuration</IuButton
          >
        </details>
        <details v-if="state?.context">
          <summary>Native context ({{ state.context.length }} entries)</summary>
          <div v-for="entry in state.context" :key="entry.id">
            <p>{{ entry.kind }} · {{ entry.id }}</p>
            <IuMarkdown v-if="'text' in entry" :source="entry.text" /><IuCodeBlock
              v-else-if="entry.kind === 'tool'"
              :code="entry.input"
            />
          </div>
        </details>
        <details v-if="state?.diff">
          <summary>Native changes ({{ state.diff.length }} files)</summary>
          <div v-for="file in state.diff" :key="file.path">
            <p>{{ file.path }} · {{ file.status }} · +{{ file.added }} / −{{ file.removed }}</p>
            <IuCodeBlock :code="file.patch" language="diff" :filename="file.path" />
          </div>
        </details>
      </template>
      <p v-else-if="!error" role="status">Loading OpenCode controls…</p>
    </div>
  </div>
</template>

<style scoped>
.native-controls__body {
  display: grid;
  gap: var(--iu-space-2);
  padding: var(--iu-space-2);
  max-height: 50vh;
  overflow: auto;
}
.native-controls__rule {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--iu-space-2);
}
</style>
