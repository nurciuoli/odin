<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useApi } from '@/api'
import { hasDesktop } from '@/app/desktop'
import { IuShell } from '@/components/AppShell'
import { IuToaster } from '@/components/Toast'
import AppHeader from '@/app/AppHeader.vue'
import AppPalette from '@/app/AppPalette.vue'
import NewProjectDialog from '@/app/NewProjectDialog.vue'
import AppSidebar from '@/app/AppSidebar.vue'
import QuickLaunch from '@/app/QuickLaunch.vue'
import ShortcutsHelp from '@/app/ShortcutsHelp.vue'
import { useAppShortcuts } from '@/app/appShortcuts'
import { createProjectsStore, PROJECTS_KEY } from '@/app/projects'
import { createSessionsStore, SESSIONS_KEY, titleFor } from '@/app/sessions'

// A session draws its own column headers (conversation, artifacts) edge to edge; every other page gets the shared
// page header band above its padded content.
const route = useRoute()
const ownColumns = computed(() => route.name === 'session')
// A project lays out its own columns too (the Overview and the docked panel each scroll), under the shared header.
const flush = computed(() => ownColumns.value || route.matched.some(r => r.path === '/p/:name'))

// The shell hides the native title bar and overlays its buttons on this header. A browser has no bridge.
if (typeof document !== 'undefined' && hasDesktop())
  document.documentElement.classList.add('is-desktop-shell')

// One project store, one sessions store, each with one event subscription for the whole app.
const api = useApi()
const store = createProjectsStore(api)
const sessions = createSessionsStore(api)
provide(PROJECTS_KEY, store)
provide(SESSIONS_KEY, sessions)
// The tab title says how many sessions wait for you.
watch(
  () => sessions.waiting.value.length,
  n => (document.title = titleFor(n)),
  { immediate: true },
)

// The palette (⌘K), quick launch (⌘⇧O) and the shortcuts cheat sheet (?), each mounted once for the whole app.
const paletteOpen = ref(false)
const quickLaunchOpen = ref(false)
const quickLaunchHarness = ref<string | undefined>(undefined)
const helpOpen = ref(false)
const { goNextWaiting } = useAppShortcuts(
  { palette: paletteOpen, quickLaunch: quickLaunchOpen, help: helpOpen },
  sessions,
)

// The palette can preset the harness ("New session on Codex"); the shortcut and plain "New session" leave it alone.
function launchWith(opts?: { harness?: string }) {
  quickLaunchHarness.value = opts?.harness
  quickLaunchOpen.value = true
}

onMounted(() => {
  store.start()
  sessions.start()
})
onBeforeUnmount(() => {
  store.stop()
  sessions.stop()
})
</script>

<template>
  <IuShell :flush="flush">
    <template #rail><AppSidebar /></template>
    <template v-if="!ownColumns" #header><AppHeader /></template>
    <RouterView />
  </IuShell>
  <AppPalette v-model:open="paletteOpen" @quick-launch="launchWith" @next-waiting="goNextWaiting" />
  <QuickLaunch v-model:open="quickLaunchOpen" :harness="quickLaunchHarness" />
  <NewProjectDialog />
  <ShortcutsHelp v-model:open="helpOpen" />
  <IuToaster />
</template>
