<script setup lang="ts">
// Asked when switching branches with uncommitted changes: stash them (they come back when you return), carry them
// over, commit first, or leave this checkout alone and start a new session on the other branch.
import { computed, ref, watch } from 'vue'
import type { GitStatus } from '@odin/shared/git'
import { IuButton } from '@/components/Button'
import { IuRadio } from '@/components/Fields'
import { IuDialog } from '@/components/Modal'

export type DirtyChoice = 'stash' | 'carry' | 'commit' | 'session'

const props = defineProps<{
  branch: string
  from: string
  status: GitStatus | null
  /** `main · odin`: the checkout being left. */
  place?: string
}>()
const emit = defineEmits<{ choose: [choice: DirtyChoice] }>()
const open = defineModel<boolean>('open', { required: true })

const choice = ref<DirtyChoice>('stash')
watch(open, v => {
  if (v) choice.value = 'stash'
})

const count = computed(() => {
  const s = props.status
  return s ? new Set([...s.staged, ...s.unstaged].map(c => c.path)).size : 0
})
const local = computed(() => props.branch.replace(/^origin\//, ''))
const options = computed(() => [
  {
    value: 'stash' as const,
    title: 'Stash them and switch',
    hint: 'They come back on their own when you return to this branch.',
    recommended: true,
  },
  {
    value: 'carry' as const,
    title: `Bring them to ${local.value}`,
    hint: "Carries the edits over. Git stops if they clash with what's on that branch.",
  },
  {
    value: 'commit' as const,
    title: 'Commit first',
    hint: 'Opens the commit box. Switch again once it is committed.',
  },
  {
    value: 'session' as const,
    title: `Start a new session on ${local.value} instead`,
    hint: props.place
      ? `Keeps ${props.place} as it is. Nothing is stashed.`
      : 'Keeps this checkout as it is. Nothing is stashed.',
  },
])
const action = computed(
  () =>
    ({
      stash: 'Stash and switch',
      carry: 'Bring them and switch',
      commit: 'Open the commit box',
      session: 'New session',
    })[choice.value],
)
</script>

<template>
  <IuDialog v-model:open="open" size="sm">
    <template #header>
      <h2 class="dirty-switch__title">
        Switch to <span class="dirty-switch__mono">{{ local }}</span
        >?
      </h2>
    </template>
    <p class="dirty-switch__lede">
      {{ count }} {{ count === 1 ? 'file has' : 'files have' }} uncommitted changes on
      <span class="dirty-switch__mono">{{ from }}</span
      >.
    </p>
    <div class="dirty-switch__options" role="radiogroup" aria-label="What to do with the changes">
      <div
        v-for="o in options"
        :key="o.value"
        class="dirty-switch__option"
        :class="{
          'dirty-switch__option--on': choice === o.value,
          'dirty-switch__option--alt': o.value === 'session',
        }"
        @click="choice = o.value"
      >
        <IuRadio v-model="choice" :value="o.value" name="dirty-switch" />
        <span class="dirty-switch__text">
          <span class="dirty-switch__option-title"
            >{{ o.title }}
            <span v-if="o.recommended" class="dirty-switch__rec">Recommended</span></span
          >
          <span class="dirty-switch__hint">{{ o.hint }}</span>
        </span>
      </div>
    </div>
    <template #footer>
      <IuButton variant="secondary" size="sm" @click="open = false">Cancel</IuButton>
      <IuButton variant="primary" size="sm" @click="emit('choose', choice)">{{ action }}</IuButton>
    </template>
  </IuDialog>
</template>

<style>
.dirty-switch__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.dirty-switch__mono {
  font-family: var(--iu-font-mono);
  font-size: 0.92em;
}
.dirty-switch__lede {
  margin: 0 0 14px;
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.dirty-switch__options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dirty-switch__option {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 10px 12px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  cursor: pointer;
}
.dirty-switch__option--on {
  border-color: var(--iu-accent-border);
  background: var(--iu-accent-wash);
}
.dirty-switch__option--alt {
  border-style: dashed;
}
.dirty-switch__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.dirty-switch__option-title {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
}
.dirty-switch__hint {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.dirty-switch__rec {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: var(--iu-radius-pill);
  font-size: var(--iu-font-size-11);
  color: var(--iu-positive);
  background: var(--iu-positive-wash);
}
</style>
