<script setup lang="ts">
// The session's artifacts, in a sandboxed frame. Inline it is the subpanel under the browser: a collapsible bar
// (the artifacts, the one on show and its version, a gear for the version picker and PDF export) over the frame, one
// tab per artifact when there are several. Its body is a fixed share of the window, so the browser above keeps room.
// On a narrow window it is an overlay drawer over the conversation: the screen owns `open` and puts focus back on the
// opener when it closes.
//
// It opens on the newest artifact. A new artifact arriving selects its tab and expands the subpanel, without moving
// focus. Showing one from a thread card or the browser selects and expands it, also without moving focus. Tabs that
// have been shown stay mounted (hidden), so a half-filled form survives a look at another tab.
import { computed, nextTick, reactive, ref, useId, useTemplateRef, watch } from 'vue'
import type { Artifact, Session } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuSidePanel } from '@/components/SidePanel'
import { IuTabs, type Tab } from '@/components/Tabs'
import ArtifactFrame from './ArtifactFrame.vue'
import { artifactOrder, newestArtifact, tabLabel, versionNumbers } from './artifacts'
import { getDesktop } from '@/app/desktop'
import { useToast } from '@/components/Toast'

const props = withDefaults(
  defineProps<{
    artifacts: Artifact[]
    /** Width supplied by the session workbench when the column is resized. */
    width?: number
    /** `overlay` on a narrow window: a drawer over the conversation. */
    presentation?: 'inline' | 'overlay'
    showTabs?: boolean
  }>(),
  { presentation: 'inline', showTabs: true },
)

const emit = defineEmits<{
  answered: [session: Session]
  close: []
  /** The artifact version on show, whenever it changes. */
  shown: [id: number, version: number]
}>()

/** Inline: the subpanel's body is shown. Overlay: the drawer is open. */
const open = defineModel<boolean>('open', { default: false })

const api = useApi()
const { toast } = useToast()
async function exportPdf() {
  const artifact = selected.value
  if (!artifact) return
  const version = shown.value
  try {
    const desktop = getDesktop()
    if (desktop?.exportArtifactPdf) await desktop.exportArtifactPdf(artifact.id, version)
    else
      window.open(`/api/artifacts/${artifact.id}/print/${version}`, '_blank', 'noopener,noreferrer')
  } catch (error) {
    toast({
      title: 'PDF export failed',
      description: error instanceof Error ? error.message : String(error),
      intent: 'danger',
    })
  }
}
const overlay = computed(() => props.presentation === 'overlay')
const ordered = computed(() => artifactOrder(props.artifacts))

// ── selection ───────────────────────────────────────────────────────────────
// null until the user (or an arrival) picks one: the newest is on show
const selectedId = ref<number | null>(null)
const selected = computed(
  () => ordered.value.find(a => a.id === selectedId.value) ?? ordered.value.at(-1) ?? null,
)
/** Tabs shown so far: their frames stay mounted. */
const mounted = reactive(new Set<number>(selected.value ? [selected.value.id] : []))
watch(
  selected,
  a => {
    if (a) mounted.add(a.id)
  },
  { immediate: true },
)

// A version the user picked, per artifact; without one the artifact shows its latest.
const pinned = reactive(new Map<number, number>())
const shownVersion = (a: Artifact) => pinned.get(a.id) ?? a.latestVersion

// Arrivals: a new artifact takes the selection; a new version of one replaces a pinned older one.
const known = new Map(ordered.value.map(a => [a.id, a.latestVersion]))
watch(
  () => props.artifacts.map(a => [a.id, a.latestVersion] as const),
  list => {
    const arrived = props.artifacts.filter(a => !known.has(a.id))
    for (const [id, latest] of list) {
      const before = known.get(id)
      if (before !== undefined && latest > before) {
        pinned.delete(id)
        void loadVersions(id)
      }
      known.set(id, latest)
    }
    const newest = newestArtifact(arrived)
    if (newest) {
      selectedId.value = newest.id
      if (!overlay.value) open.value = true
    }
  },
)

/** Show this artifact (and this version of it): what a card in the thread does. */
function show(id: number, version?: number) {
  selectedId.value = id
  if (!overlay.value) open.value = true
  const a = props.artifacts.find(x => x.id === id)
  if (!a) return
  if (version === undefined || version === a.latestVersion) pinned.delete(id)
  else pinned.set(id, version)
}

// ── versions ────────────────────────────────────────────────────────────────
const listed = reactive(new Map<number, number[]>())
async function loadVersions(id: number) {
  try {
    listed.set(
      id,
      (await api.getArtifact(id)).versions.map(v => v.version),
    )
  } catch {
    // the picker steps through what it knows: the latest and the one on show
  }
}
watch(
  () => selected.value?.id,
  id => {
    if (id !== undefined && !listed.has(id)) void loadVersions(id)
  },
  { immediate: true },
)

const shown = computed(() => (selected.value ? shownVersion(selected.value) : 1))
const numbers = computed(() =>
  selected.value
    ? versionNumbers(listed.get(selected.value.id) ?? [], selected.value.latestVersion, shown.value)
    : [],
)
const latest = computed(() => numbers.value.at(-1) ?? shown.value)
const index = computed(() => numbers.value.indexOf(shown.value))
function step(by: number) {
  const next = numbers.value[index.value + by]
  if (next !== undefined && selected.value) show(selected.value.id, next)
}

watch(
  () => (selected.value ? `${selected.value.id}/${shown.value}` : ''),
  key => {
    const [id, version] = key.split('/').map(Number)
    if (key && id !== undefined && version !== undefined) emit('shown', id, version)
  },
  { immediate: true },
)

// ── width ───────────────────────────────────────────────────────────────────
const expanded = ref(false)
const width = computed(() => props.width ?? (expanded.value ? 720 : 520))

// ── the gear ────────────────────────────────────────────────────────────────
const menuItems = computed<MenuItem[]>(() => [
  { type: 'label', label: `Version ${shown.value} of ${latest.value}` },
  {
    id: 'prev',
    label: 'Previous version',
    icon: 'chevronLeft',
    disabled: index.value <= 0,
  },
  {
    id: 'next',
    label: 'Next version',
    icon: 'chevronRight',
    disabled: index.value >= numbers.value.length - 1,
  },
  {
    id: 'latest',
    label: `Show latest (v${latest.value})`,
    disabled: shown.value === latest.value,
  },
  { type: 'separator' },
  { id: 'pdf', label: 'Export PDF / print', disabled: !selected.value },
  ...(overlay.value && props.width === undefined
    ? [{ id: 'expand', type: 'check' as const, label: 'Wide panel', checked: expanded.value }]
    : []),
])
function onMenu(id: string) {
  if (id === 'pdf') {
    void exportPdf()
    return
  }
  if (id === 'prev') step(-1)
  else if (id === 'next') step(1)
  else if (id === 'latest' && selected.value) show(selected.value.id)
  else if (id === 'expand') expanded.value = !expanded.value
}

// ── tabs ────────────────────────────────────────────────────────────────────
const idBase = useId()
const tabs = computed<Tab[]>(() =>
  ordered.value.map(a => ({ id: String(a.id), label: tabLabel(a.title) })),
)
const activeTab = computed({
  get: () => String(selected.value?.id ?? ''),
  set: id => show(Number(id)),
})
const multiple = computed(() => props.showTabs && ordered.value.length > 1)
// A tab row wider than the header scrolls; keep the selected tab in sight (scrolling only, focus stays put).
watch(
  () => selected.value?.id,
  async id => {
    await nextTick()
    const tab = document.getElementById(`${idBase}-tab-${id}`)
    if (typeof tab?.scrollIntoView === 'function')
      tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  },
  { immediate: true },
)

// ── subpanel and drawer ─────────────────────────────────────────────────────
const bodyId = useId()
const panel = useTemplateRef<{ focus: () => void }>('panel')
/** Called by the screen after the user opened the drawer. */
async function focus() {
  await nextTick()
  panel.value?.focus()
}

defineExpose({ show, focus })
</script>

<template>
  <section v-if="!overlay" class="artifact-panel artifact-panel--sub" aria-label="Artifacts">
    <div class="artifact-panel__bar">
      <button
        type="button"
        class="artifact-panel__toggle"
        :aria-expanded="open"
        :aria-controls="bodyId"
        @click="open = !open"
      >
        <IuIcon :name="open ? 'chevronDown' : 'chevronRight'" :size="14" />
        <span class="artifact-panel__label">Artifacts</span>
        <span class="artifact-panel__count">{{ ordered.length }}</span>
        <span class="artifact-panel__summary">{{ selected?.title }}</span>
      </button>
      <span class="artifact-panel__version" aria-live="polite"
        >v{{ shown }}<template v-if="numbers.length > 1"> of {{ latest }}</template></span
      >
      <IuMenu :items="menuItems" @select="onMenu">
        <template #trigger="{ toggle, open: menuOpen }">
          <IuButton
            variant="ghost"
            size="sm"
            icon-only
            aria-label="Artifact settings"
            aria-haspopup="menu"
            :aria-expanded="menuOpen"
            @click="toggle"
          >
            <template #icon><IuIcon name="gear" :size="16" /></template>
          </IuButton>
        </template>
      </IuMenu>
    </div>
    <div v-show="open" :id="bodyId" class="artifact-panel__body">
      <div v-if="multiple" class="artifact-panel__tabs">
        <IuTabs
          v-model="activeTab"
          :tabs="tabs"
          variant="segmented"
          :panels="false"
          :id-base="idBase"
        />
      </div>
      <template v-for="a in ordered" :key="a.id">
        <div
          v-if="mounted.has(a.id)"
          v-show="a.id === selected?.id"
          :id="multiple ? `${idBase}-panel-${a.id}` : undefined"
          class="artifact-panel__view"
          :role="multiple ? 'tabpanel' : undefined"
          :aria-labelledby="multiple ? `${idBase}-tab-${a.id}` : undefined"
        >
          <ArtifactFrame
            :artifact-id="a.id"
            :version="shownVersion(a)"
            :title="a.title"
            @answered="emit('answered', $event)"
          />
        </div>
      </template>
    </div>
  </section>
  <IuSidePanel
    v-else
    ref="panel"
    class="artifact-panel"
    variant="column"
    presentation="overlay"
    :width="width"
    :open="open"
    closable
    aria-label="Artifacts"
    @update:open="open = $event"
    @close="emit('close')"
  >
    <template #header>
      <div v-if="multiple" class="artifact-panel__tabs">
        <IuTabs
          v-model="activeTab"
          :tabs="tabs"
          variant="segmented"
          :panels="false"
          :id-base="idBase"
        />
      </div>
      <h2 v-else class="artifact-panel__title" :title="selected?.title">
        {{ selected?.title }}
      </h2>
    </template>

    <template #actions>
      <span class="artifact-panel__version" aria-live="polite"
        >v{{ shown }}<template v-if="numbers.length > 1"> of {{ latest }}</template></span
      >
      <IuMenu :items="menuItems" @select="onMenu">
        <template #trigger="{ toggle, open: menuOpen }">
          <IuButton
            variant="ghost"
            size="sm"
            icon-only
            aria-label="Artifact settings"
            aria-haspopup="menu"
            :aria-expanded="menuOpen"
            @click="toggle"
          >
            <template #icon><IuIcon name="gear" :size="16" /></template>
          </IuButton>
        </template>
      </IuMenu>
    </template>

    <template v-for="a in ordered" :key="a.id">
      <div
        v-if="mounted.has(a.id)"
        v-show="a.id === selected?.id"
        :id="multiple ? `${idBase}-panel-${a.id}` : undefined"
        class="artifact-panel__view"
        :role="multiple ? 'tabpanel' : undefined"
        :aria-labelledby="multiple ? `${idBase}-tab-${a.id}` : undefined"
      >
        <ArtifactFrame
          :artifact-id="a.id"
          :version="shownVersion(a)"
          :title="a.title"
          @answered="emit('answered', $event)"
        />
      </div>
    </template>
  </IuSidePanel>
</template>

<style>
.artifact-panel__tabs {
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}
.artifact-panel__title {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
  color: var(--iu-text);
}
.artifact-panel__version {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  white-space: nowrap;
}
.artifact-panel__view {
  flex: 1;
  min-height: 0;
}
.artifact-panel--sub {
  display: flex;
  flex: none;
  flex-direction: column;
  min-width: 0;
  background: var(--iu-ground);
}
.artifact-panel__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  min-height: 36px;
  padding: 0 6px 0 4px;
}
.artifact-panel__toggle {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 32px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text);
  font: inherit;
  font-size: var(--iu-font-size-13);
  text-align: left;
  cursor: pointer;
}
.artifact-panel__toggle:hover {
  background: var(--iu-well);
}
.artifact-panel__toggle:focus-visible {
  outline: 2px solid var(--iu-accent);
  outline-offset: -2px;
}
.artifact-panel__toggle > .iu-icon {
  flex: none;
  color: var(--iu-text-muted);
}
.artifact-panel__label {
  flex: none;
  font-weight: var(--iu-font-weight-medium);
  white-space: nowrap;
}
.artifact-panel__count {
  flex: none;
  color: var(--iu-text-muted);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
}
.artifact-panel__summary {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--iu-text-2);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* the subpanel's body is a share of the window, clamped; the browser above takes the rest and scrolls */
.artifact-panel__body {
  display: flex;
  flex-direction: column;
  height: clamp(200px, 44vh, 480px);
  min-height: 0;
}
.artifact-panel__body > .artifact-panel__view {
  display: flex;
  flex-direction: column;
}
.artifact-panel--sub > .artifact-panel__body > .artifact-panel__tabs {
  padding: 0 8px 6px;
}
</style>
