<script setup lang="ts">
// Pick a library asset and install it into this project. A 409 (an untracked file is in the way) is explained and
// can be retried with force.
import { computed, ref, watch } from 'vue'
import type { LibraryAsset } from '@odin/shared/api'
import { isInstallable } from '@odin/shared/library'
import { ApiRequestError, useApi } from '@/api'
import { IuBadge } from '@/components/Badge'
import { IuButton } from '@/components/Button'
import { IuCallout } from '@/components/Callout'
import { IuDialog } from '@/components/Modal'
import { IuEmpty, IuErrorState, IuSkeleton } from '@/components/States'

const props = defineProps<{ project: string; installed: string[] }>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ installed: [] }>()

const api = useApi()
const phase = ref<'loading' | 'ready' | 'error'>('loading')
const error = ref('')
const assets = ref<LibraryAsset[]>([])
const choice = ref<string | null>(null)
const installing = ref(false)
const failure = ref<{ message: string; conflict: boolean } | null>(null)

const key = (a: Pick<LibraryAsset, 'kind' | 'id'>) => `${a.kind}/${a.id}`
const offered = computed(() =>
  assets.value.filter(a => isInstallable(a.kind) && !props.installed.includes(key(a)) && !a.error),
)
const picked = computed(() => offered.value.find(a => key(a) === choice.value) ?? null)

async function load() {
  phase.value = 'loading'
  try {
    assets.value = await api.listLibrary()
    phase.value = 'ready'
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    phase.value = 'error'
  }
}
watch(
  open,
  isOpen => {
    if (!isOpen) return
    choice.value = null
    failure.value = null
    void load()
  },
  { immediate: true },
)

async function install(force = false) {
  const a = picked.value
  if (!a) return
  installing.value = true
  failure.value = null
  try {
    await api.install(props.project, { kind: a.kind, id: a.id, action: 'install', force })
    emit('installed')
    open.value = false
  } catch (e) {
    failure.value = {
      message: e instanceof Error ? e.message : String(e),
      conflict: e instanceof ApiRequestError && e.status === 409,
    }
  } finally {
    installing.value = false
  }
}
</script>

<template>
  <IuDialog v-model:open="open" size="md">
    <template #header>
      <h2 class="install-lib__title">Install from library</h2>
    </template>
    <IuSkeleton v-if="phase === 'loading'" shape="row" :rows="3" />
    <IuErrorState
      v-else-if="phase === 'error'"
      title="Couldn't load the library"
      :body="error"
      trace-id="project.library.list"
      @retry="load()"
    />
    <IuEmpty
      v-else-if="!offered.length"
      title="Nothing left to install"
      body="Agents, skills, commands, MCP servers and settings profiles that are not yet in this project show up here."
    />
    <fieldset v-else class="install-lib__list">
      <legend class="install-lib__legend">Choose an asset</legend>
      <label v-for="a in offered" :key="key(a)" class="install-lib__option">
        <input v-model="choice" type="radio" name="asset" :value="key(a)" />
        <span class="install-lib__main">
          <span class="install-lib__name">{{ a.name }}</span>
          <span class="install-lib__desc">{{ a.description }}</span>
        </span>
        <IuBadge variant="tag" size="xs">{{ a.kind }}</IuBadge>
      </label>
    </fieldset>
    <IuCallout
      v-if="failure"
      intent="danger"
      title="Couldn't install"
      live
      class="install-lib__fail"
    >
      {{ failure.message }}
      <template v-if="failure.conflict">
        A file of that name is already in the project. Installing again overwrites it.
      </template>
    </IuCallout>
    <template #footer>
      <IuButton variant="ghost" size="sm" @click="open = false">Cancel</IuButton>
      <IuButton
        v-if="failure?.conflict"
        variant="danger"
        size="sm"
        :loading="installing"
        @click="install(true)"
      >
        Overwrite and install
      </IuButton>
      <IuButton
        v-else
        variant="primary"
        size="sm"
        :disabled="!picked"
        :loading="installing"
        @click="install()"
      >
        Install
      </IuButton>
    </template>
  </IuDialog>
</template>

<style>
.install-lib__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
}
.install-lib__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.install-lib__legend {
  padding: 0;
  margin-bottom: 8px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.install-lib__option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-md);
  cursor: pointer;
}
.install-lib__option:has(input:checked) {
  border-color: var(--iu-accent);
}
.install-lib__option:has(input:focus-visible) {
  outline: 2px solid var(--iu-accent);
  outline-offset: 1px;
}
.install-lib__main {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}
.install-lib__name {
  font-size: var(--iu-font-size-13);
  color: var(--iu-text);
}
.install-lib__desc {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.install-lib__fail {
  margin-top: 12px;
}
</style>
