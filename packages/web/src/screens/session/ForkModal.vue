<script setup lang="ts">
// Fork a session: a new session that starts from this one's conversation, optionally in its own worktree and with
// a first message. The server does the work; this only collects the three choices.
import { ref, watch } from 'vue'
import type { ForkSessionRequest, Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuField, IuSwitch, IuTextarea } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'

const props = defineProps<{
  sessionId: string
  /** The parent's title, for the default fork title. */
  title: string
  /** Whether the parent already runs in a worktree (the default is the same workspace). */
  inWorktree: boolean
}>()

const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ forked: [session: Session] }>()

const api = useApi()
const forkTitle = ref('')
const worktree = ref(false)
const prompt = ref('')
const sending = ref(false)
const error = ref<string | null>(null)

// a fresh form every time it opens
watch(
  open,
  isOpen => {
    if (!isOpen) return
    forkTitle.value = `${props.title} (fork)`
    worktree.value = false
    prompt.value = ''
    error.value = null
  },
  { immediate: true },
)

async function fork() {
  if (sending.value) return
  sending.value = true
  error.value = null
  const req: ForkSessionRequest = { worktree: worktree.value }
  if (forkTitle.value.trim()) req.title = forkTitle.value.trim()
  if (prompt.value.trim()) req.prompt = { text: prompt.value.trim() }
  try {
    const session = await api.forkSession(props.sessionId, req)
    open.value = false
    emit('forked', session)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" size="md">
    <template #header>
      <h2 class="fork-modal__title">Fork this session</h2>
    </template>
    <form class="fork-modal__form" @submit.prevent="fork">
      <p class="fork-modal__note">
        The fork starts with this conversation so far. The original keeps going on its own.
      </p>
      <IuField v-model="forkTitle" label="Title" />
      <IuSwitch v-model="worktree" label="Run the fork in a new worktree" />
      <p class="fork-modal__hint">
        {{
          worktree
            ? 'It gets its own branch and folder, so its edits stay apart.'
            : inWorktree
              ? 'It shares the original’s worktree and branch.'
              : 'It shares the project checkout with the original.'
        }}
      </p>
      <IuTextarea
        v-model="prompt"
        label="First message (optional)"
        hint="Without one, the fork waits for you."
        :rows="3"
      />
      <IuCallout v-if="error" intent="danger" variant="inline" live>{{ error }}</IuCallout>
    </form>
    <template #footer>
      <IuButton variant="secondary" size="sm" :disabled="sending" @click="open = false"
        >Cancel</IuButton
      >
      <IuButton variant="primary" size="sm" :loading="sending" @click="fork">Fork</IuButton>
    </template>
  </IuDialog>
</template>

<style>
.fork-modal__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.fork-modal__form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.fork-modal__note,
.fork-modal__hint {
  margin: 0;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-2);
}
.fork-modal__hint {
  margin-top: -8px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
