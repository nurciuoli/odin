<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import type {
  PermissionPromptAnswer,
  PermissionPromptQuestion,
  PermissionPromptRequest,
  PermissionScope,
} from './types'
import QuestionCarousel from './QuestionCarousel.vue'
import IuButton from '@/components/Button/Button.vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuEyebrow from '@/components/Eyebrow/Eyebrow.vue'
import IuStatusDot from '@/components/StatusDot/StatusDot.vue'
import IuCodeBlock from '@/components/CodeBlock/CodeBlock.vue'
import IuDiff from '@/components/CodeBlock/Diff.vue'
import IuMarkdown from '@/components/Markdown/Markdown.vue'
import IuMenu, { type MenuItem } from '@/components/Menu/Menu.vue'
import IuPropertyList, { type PropertyItem } from '@/components/PropertyList/PropertyList.vue'
import IuTextarea from '@/components/Fields/Textarea.vue'

const props = withDefaults(
  defineProps<{
    request: PermissionPromptRequest
    /** Disable the controls while an answer is being sent. */
    busy?: boolean
    /** Scopes offered for "always allow", in order. */
    scopes?: Exclude<PermissionScope, 'once'>[]
    /**
     * Put focus on Deny when a risky request mounts. Turn it off where the prompt can appear on its own (a live
     * session), so content that arrives by itself never moves focus.
     */
    autofocus?: boolean
    /** Offer a Cancel action that gives up on the request (and whatever waits on it): emits `cancel`. */
    cancellable?: boolean
    /** Accessible name of the Cancel button, saying what cancelling does. */
    cancelLabel?: string
  }>(),
  {
    busy: false,
    scopes: () => ['session', 'project', 'local', 'user'],
    autofocus: true,
    cancellable: false,
    cancelLabel: 'Cancel',
  },
)

const emit = defineEmits<{ answer: [answer: PermissionPromptAnswer]; cancel: [] }>()

const platform =
  typeof navigator === 'undefined'
    ? ''
    : ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ?? navigator.platform)
const isMac = /Mac|iPhone|iPad/i.test(platform)
const allowHint = isMac ? '⌘↵' : 'Ctrl↵'

const uid = useId()
const titleId = `${uid}-title`
const detailsId = `${uid}-details`

const SCOPE_LABEL: Record<Exclude<PermissionScope, 'once'>, string> = {
  session: 'For this session',
  project: 'For this project',
  local: 'For this project, just me',
  user: 'For all projects',
}
const scopeItems = computed<MenuItem[]>(() =>
  props.scopes.map(s => ({ id: s, label: SCOPE_LABEL[s] })),
)
const showAlways = computed(
  () => props.request.kind === 'tool' && props.request.canAlwaysAllow && props.scopes.length > 0,
)

// the input as a property list; a Bash command gets a code block instead
const command = computed(() => {
  const c = props.request.input?.command
  return props.request.tool === 'Bash' && typeof c === 'string' ? c : undefined
})
const properties = computed<PropertyItem[]>(() => {
  const input = props.request.input ?? {}
  return (
    Object.entries(input)
      .filter(([k]) => !(command.value !== undefined && k === 'command'))
      .filter(
        ([k]) =>
          !(props.request.diff?.length && ['old_string', 'new_string', 'content'].includes(k)),
      )
      // a plan already renders as markdown above
      .filter(([k]) => !(props.request.kind === 'plan' && props.request.plan && k === 'plan'))
      .map(([k, v]) => ({
        label: k,
        value: typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v)),
        mono: true,
      }))
  )
})
const hasDetails = computed(
  () =>
    props.request.kind === 'plan' ||
    props.request.kind === 'question' ||
    command.value !== undefined ||
    properties.value.length > 0 ||
    (props.request.diff?.length ?? 0) > 0 ||
    Boolean(props.request.description),
)

// question answers come from the carousel: one string per question, several joined for multi-select
const answers = ref<Record<string, string>>({})
const hint = ref('')
const questionKey = (q: PermissionPromptQuestion) => q.id ?? q.question
const complete = computed(
  () =>
    props.request.kind !== 'question' ||
    (props.request.questions ?? []).every(q => answers.value[questionKey(q)] !== undefined),
)

const message = ref('')
const messageOpen = ref(false)

function allow(scope: PermissionScope = 'once') {
  if (props.busy || !complete.value) return
  emit('answer', {
    behavior: 'allow',
    scope,
    ...(props.request.kind === 'question' ? { answers: answers.value } : {}),
  })
}
function deny() {
  if (props.busy) return
  const m = message.value.trim()
  emit('answer', m ? { behavior: 'deny', message: m } : { behavior: 'deny' })
}

function onKeydown(e: KeyboardEvent) {
  // a question's carousel handles its own Enter / Ctrl+Enter
  if (props.request.defaultToDeny || props.request.kind === 'question' || e.isComposing) return
  if (e.key === 'Enter' && (isMac ? e.metaKey : e.ctrlKey)) {
    e.preventDefault()
    allow()
  }
}

const root = ref<HTMLElement | null>(null)
onMounted(() => {
  // a risky request opens on Deny so a stray Enter can't approve it
  if (props.autofocus && props.request.defaultToDeny)
    root.value?.querySelector<HTMLButtonElement>('.iu-permission-prompt__deny')?.focus()
})

const allowLabel = computed(() =>
  props.request.kind === 'plan'
    ? 'Approve plan'
    : props.request.kind === 'question'
      ? 'Submit answers'
      : 'Allow once',
)
const denyLabel = computed(() => (props.request.kind === 'plan' ? 'Keep planning' : 'Deny'))
</script>

<template>
  <section
    ref="root"
    class="iu-permission-prompt"
    :class="{ 'is-careful': request.defaultToDeny, 'is-question': request.kind === 'question' }"
    role="group"
    :aria-labelledby="request.kind === 'question' ? undefined : titleId"
    :aria-label="request.kind === 'question' ? 'Question for you' : undefined"
    :aria-describedby="hasDetails ? detailsId : undefined"
    :aria-busy="busy"
    @keydown="onKeydown"
  >
    <div class="iu-permission-prompt__top">
      <IuStatusDot status="awaiting" :size="7" decorative />
      <IuEyebrow>{{
        request.kind === 'plan'
          ? 'Plan approval'
          : request.kind === 'question'
            ? 'Question for you'
            : 'Permission needed'
      }}</IuEyebrow>
      <span v-if="request.kind === 'question' && hint" class="iu-permission-prompt__hint">{{
        hint
      }}</span>
      <span v-if="request.defaultToDeny" class="iu-permission-prompt__risk">▲ Review first</span>
    </div>

    <template v-if="request.kind !== 'question'">
      <p :id="titleId" class="iu-permission-prompt__title">{{ request.title }}</p>
      <div class="iu-permission-prompt__tool">{{ request.tool }}</div>
    </template>

    <div v-if="hasDetails" :id="detailsId" class="iu-permission-prompt__details">
      <p v-if="request.description" class="iu-permission-prompt__desc">{{ request.description }}</p>

      <IuMarkdown v-if="request.kind === 'plan' && request.plan" :source="request.plan" size="sm" />

      <template v-if="request.kind === 'tool' || request.kind === 'plan'">
        <IuCodeBlock
          v-if="command !== undefined"
          :code="command"
          language="bash"
          max-height="200px"
        />
        <IuDiff v-if="request.diff?.length" :hunks="request.diff" max-height="240px" />
        <IuPropertyList
          v-if="properties.length"
          :items="properties"
          density="compact"
          label-width="96px"
        />
      </template>

      <QuestionCarousel
        v-if="request.kind === 'question'"
        :key="request.id"
        :questions="request.questions ?? []"
        :busy="busy"
        @update:answers="answers = $event"
        @hint="hint = $event"
        @submit="allow()"
      />
    </div>

    <IuTextarea
      v-if="messageOpen"
      v-model="message"
      label="Message to the agent (optional)"
      :rows="2"
      size="sm"
      :disabled="busy"
    />

    <div class="iu-permission-prompt__actions">
      <IuButton
        v-if="request.kind !== 'question'"
        variant="primary"
        size="sm"
        class="iu-permission-prompt__allow"
        :disabled="busy || !complete"
        @click="allow()"
      >
        {{ allowLabel }}
        <template #trailing>
          <kbd v-if="!request.defaultToDeny" class="iu-btn__kbd">{{ allowHint }}</kbd>
        </template>
      </IuButton>

      <IuMenu
        v-if="showAlways"
        :items="scopeItems"
        placement="bottom-start"
        @select="allow($event as PermissionScope)"
      >
        <template #trigger="{ open, toggle: toggleMenu }">
          <IuButton
            variant="ghost"
            size="sm"
            class="iu-permission-prompt__always"
            aria-haspopup="menu"
            :aria-expanded="open"
            :disabled="busy"
            @click="toggleMenu"
          >
            Always allow
            <template #trailing>
              <IuIcon name="chevronRight" :size="14" />
            </template>
          </IuButton>
        </template>
      </IuMenu>

      <IuButton
        :variant="request.kind === 'question' ? 'ghost' : 'secondary'"
        size="sm"
        class="iu-permission-prompt__deny"
        :disabled="busy"
        @click="deny"
      >
        {{ denyLabel }}
      </IuButton>
      <IuButton
        variant="ghost"
        size="sm"
        class="iu-permission-prompt__msg"
        :aria-expanded="messageOpen"
        :disabled="busy"
        @click="messageOpen = !messageOpen"
      >
        {{ messageOpen ? 'No message' : 'Add a message' }}
      </IuButton>
      <IuButton
        v-if="cancellable"
        variant="ghost"
        size="sm"
        class="iu-permission-prompt__cancel"
        :aria-label="cancelLabel"
        :title="cancelLabel"
        :disabled="busy"
        @click="emit('cancel')"
      >
        Cancel
      </IuButton>
    </div>
  </section>
</template>

<style>
.iu-permission-prompt {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px 14px;
  background: var(--iu-surface);
  border: 1px solid var(--iu-info-border);
  border-left: 3px solid var(--iu-info);
  border-radius: var(--iu-radius-lg);
}

.iu-permission-prompt.is-careful {
  border-color: var(--iu-warning-border);
  border-left-color: var(--iu-warning);
}

.iu-permission-prompt__top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.iu-permission-prompt__risk {
  margin-left: auto;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10-5);
  color: var(--iu-warning);
  white-space: nowrap;
}

.iu-permission-prompt__hint {
  margin-left: auto;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  white-space: nowrap;
}

.iu-permission-prompt__title {
  margin: 0;
  font-size: var(--iu-font-size-13-5);
  font-weight: var(--iu-font-weight-medium);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text);
  overflow-wrap: anywhere;
}

.iu-permission-prompt__tool {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}

.iu-permission-prompt__details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.iu-permission-prompt__desc {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}

.iu-permission-prompt__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.iu-permission-prompt__msg {
  margin-left: auto;
}

/* a question's controls sit in the middle of the card, under the carousel's own */
.iu-permission-prompt.is-question .iu-permission-prompt__actions {
  justify-content: center;
  padding-top: 8px;
  border-top: 1px solid var(--iu-border);
}
.iu-permission-prompt.is-question .iu-permission-prompt__msg {
  margin-left: 0;
}
</style>
