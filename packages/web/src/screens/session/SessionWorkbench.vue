<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import { PREVIEW_MIN, maxPreviewWidth } from '@/app/layout'
import { IuButton } from '@/components/Button'
import { IuTabs } from '@/components/Tabs'
import SessionEnvironment from './SessionEnvironment.vue'
import ChangesPanel from '@/screens/git/ChangesPanel.vue'
import type SessionFilesType from './SessionFiles.vue'
import type { PreviewView } from './workbench'
import type { CellRef } from './fileActivity'
const SessionFiles = defineAsyncComponent(() => import('./SessionFiles.vue'))
const props = withDefaults(
  defineProps<{ session: SessionDetail; width: number; resizable?: boolean }>(),
  { resizable: false },
)
const emit = defineEmits<{ close: []; 'update:width': [width: number] }>()
const tab = defineModel<PreviewView>('tab', { required: true })
const filesTab = ref<'files' | 'changes' | 'environment'>('files')
const filesTabs = [
  { id: 'files', label: 'Files' },
  { id: 'changes', label: 'Changes' },
  { id: 'environment', label: 'Environment' },
]
const stackedArtifact = computed(() => tab.value === 'artifacts' && props.resizable)
watch(stackedArtifact, stacked => {
  if (stacked) filesTab.value = 'files'
})
const gitTarget = computed(() => ({ kind: 'session' as const, id: props.session.id }))
/** Opens the Changes tab (the header's changed-files count). */
function openChanges() {
  tab.value = 'files'
  filesTab.value = 'changes'
}
const filePanel = ref<InstanceType<typeof SessionFilesType>>()
const pendingPath = ref<string | null>(null)
const pendingCell = ref<CellRef | null>(null)
watch(filePanel, panel => {
  if (panel && pendingPath.value !== null) {
    void panel.open(pendingPath.value)
    pendingPath.value = null
  }
  if (panel && pendingCell.value) {
    void panel.openCell(pendingCell.value)
    pendingCell.value = null
  }
})
function openCell(cell: CellRef) {
  tab.value = 'files'
  filesTab.value = 'files'
  if (filePanel.value) void filePanel.value.openCell(cell)
  else pendingCell.value = cell
}
function openFile(path: string) {
  tab.value = 'files'
  filesTab.value = 'files'
  const root = props.session.cwd.replaceAll('\\', '/').replace(/\/$/, '')
  const normalized = path.replaceAll('\\', '/')
  const relative = normalized.startsWith(root + '/')
    ? normalized.slice(root.length + 1)
    : normalized
  if (filePanel.value) void filePanel.value.open(relative)
  else pendingPath.value = relative
}

const MIN_WIDTH = PREVIEW_MIN
const MAX_WIDTH = 960
const shell = ref<HTMLElement>()
const availableWidth = ref(typeof window === 'undefined' ? 1600 : window.innerWidth)
let observer: ResizeObserver | undefined
function measureAvailableWidth() {
  availableWidth.value = shell.value?.parentElement?.clientWidth || window.innerWidth
}
onMounted(() => {
  measureAvailableWidth()
  window.addEventListener('resize', measureAvailableWidth)
  if (typeof ResizeObserver !== 'undefined' && shell.value?.parentElement) {
    observer = new ResizeObserver(measureAvailableWidth)
    observer.observe(shell.value.parentElement)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measureAvailableWidth)
  observer?.disconnect()
})
const maxWidth = computed(() => maxPreviewWidth(availableWidth.value, MAX_WIDTH))
const boundedWidth = computed(() => Math.min(props.width, maxWidth.value))
watch(
  boundedWidth,
  value => {
    if (value !== props.width) emit('update:width', value)
  },
  { immediate: true },
)

const splitter = ref<HTMLElement>()
const drag = ref<{ id: number; startX: number; startWidth: number } | null>(null)
function stopDrag() {
  const current = drag.value
  drag.value = null
  window.removeEventListener('pointerup', onWindowPointer)
  window.removeEventListener('pointercancel', onWindowPointer)
  if (current && splitter.value?.hasPointerCapture(current.id))
    splitter.value.releasePointerCapture(current.id)
  document.documentElement.classList.remove('session-workbench--resizing')
}
function onWindowPointer(event: PointerEvent) {
  const current = drag.value
  if (!current || current.id !== event.pointerId) return
  stopDrag()
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  drag.value = { id: event.pointerId, startX: event.clientX, startWidth: boundedWidth.value }
  splitter.value?.setPointerCapture(event.pointerId)
  document.documentElement.classList.add('session-workbench--resizing')
  window.addEventListener('pointerup', onWindowPointer)
  window.addEventListener('pointercancel', onWindowPointer)
}
function moveDrag(event: PointerEvent) {
  const current = drag.value
  if (!current || current.id !== event.pointerId) return
  emit(
    'update:width',
    Math.max(
      MIN_WIDTH,
      Math.min(maxWidth.value, current.startWidth + current.startX - event.clientX),
    ),
  )
}
function keyResize(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') emit('update:width', MIN_WIDTH)
  else if (event.key === 'End') emit('update:width', maxWidth.value)
  else
    emit(
      'update:width',
      Math.max(
        MIN_WIDTH,
        Math.min(
          maxWidth.value,
          boundedWidth.value + (event.key === 'ArrowLeft' ? 16 : -16) * (event.shiftKey ? 4 : 1),
        ),
      ),
    )
}
watch(
  () => props.resizable,
  value => {
    if (!value) stopDrag()
  },
)
onBeforeUnmount(stopDrag)
defineExpose({ openFile, openCell, openChanges })
</script>
<template>
  <div
    ref="shell"
    class="session-workbench-shell"
    :style="{ '--session-workbench-width': `${boundedWidth}px` }"
  >
    <div
      v-if="resizable"
      ref="splitter"
      class="session-workbench__splitter"
      role="separator"
      aria-label="Resize content preview"
      aria-orientation="vertical"
      :aria-valuemin="MIN_WIDTH"
      :aria-valuemax="maxWidth"
      :aria-valuenow="boundedWidth"
      tabindex="0"
      @pointerdown="startDrag"
      @pointermove="moveDrag"
      @pointerup="stopDrag"
      @pointercancel="stopDrag"
      @lostpointercapture="stopDrag"
      @keydown="keyResize"
    />
    <aside class="session-workbench" :data-tab="tab" aria-label="Content preview">
      <div class="session-workbench__topbar">
        <IuButton
          variant="ghost"
          size="sm"
          :aria-label="tab === 'files' ? 'Hide workspace' : 'Hide preview'"
          @click="emit('close')"
        >
          {{ tab === 'files' ? 'Hide workspace' : 'Hide preview' }}
        </IuButton>
      </div>
      <div
        class="session-workbench__content"
        :class="{ 'session-workbench__content--stacked': stackedArtifact }"
      >
        <div v-if="drag" class="session-workbench__drag-shield" aria-hidden="true" />
        <div v-show="tab === 'files' || stackedArtifact" class="session-workbench__file-panel">
          <IuTabs
            v-model="filesTab"
            class="session-workbench__file-tabs"
            :tabs="filesTabs"
            :bar-height="48"
            :panels="false"
            id-base="session-files-tabs"
            @update:model-value="tab = 'files'"
          />
          <div
            v-show="filesTab === 'files'"
            id="session-files-tabs-panel-files"
            class="session-workbench__file-tab"
            role="tabpanel"
            aria-labelledby="session-files-tabs-tab-files"
          >
            <SessionFiles
              :key="session.id"
              ref="filePanel"
              :session="session"
              :browsing-only="stackedArtifact"
              @hide="emit('close')"
              @activate-document="tab = 'files'"
              @open-environment="filesTab = 'environment'"
            />
          </div>
          <div
            v-if="filesTab === 'changes'"
            id="session-files-tabs-panel-changes"
            class="session-workbench__file-tab"
            role="tabpanel"
            aria-labelledby="session-files-tabs-tab-changes"
          >
            <ChangesPanel
              :target="gitTarget"
              :session="session"
              @open="
                path => {
                  filesTab = 'files'
                  openFile(path)
                }
              "
            />
          </div>
          <div
            v-if="filesTab === 'environment'"
            id="session-files-tabs-panel-environment"
            class="session-workbench__file-tab"
            role="tabpanel"
            aria-labelledby="session-files-tabs-tab-environment"
          >
            <SessionEnvironment :key="session.id" :session="session" />
          </div>
        </div>
        <div v-show="tab === 'artifacts'" class="session-workbench__artifacts">
          <slot name="artifacts" />
        </div>
        <div v-show="tab === 'activity'" class="session-workbench__activity">
          <slot name="activity" />
        </div>
        <div v-show="tab === 'side'" class="session-workbench__side">
          <slot name="side" />
        </div>
      </div>
    </aside>
  </div>
</template>
<style>
.session-workbench-shell {
  position: relative;
  flex: none;
  width: var(--session-workbench-width);
  min-height: 0;
  min-width: 0;
  display: flex;
}
.session-workbench {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--iu-border-quiet);
  background: var(--iu-ground);
}
.session-workbench__topbar {
  position: relative;
  z-index: 4;
  flex: none;
  height: 48px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding: 0 10px 0 8px;
  border-bottom: 1px solid var(--iu-border-quiet);
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
}
.session-workbench__content {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
}
.session-workbench__file-tabs {
  flex: none;
}
.session-workbench__content--stacked {
  flex-direction: column;
}
.session-workbench__content--stacked > .session-workbench__file-panel {
  flex: 0 1 42%;
  min-height: min(200px, 50%);
  border-bottom: 1px solid var(--iu-border);
}
.session-workbench__file-tab {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
}
.session-workbench__file-panel,
.session-workbench__activity,
.session-workbench__side,
.session-workbench__artifacts {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  flex-direction: column;
}
.session-workbench__splitter {
  position: relative;
  z-index: 3;
  flex: none;
  width: 8px;
  margin-right: -4px;
  cursor: col-resize;
  touch-action: none;
}
.session-workbench__splitter::after {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: transparent;
}
.session-workbench__splitter:hover::after,
.session-workbench__splitter:focus-visible::after {
  background: var(--iu-border-quiet);
}
.session-workbench__splitter:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.session-workbench__drag-shield {
  position: absolute;
  z-index: 2;
  inset: 0;
  cursor: col-resize;
}
.session-workbench--resizing,
.session-workbench--resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}
@media (max-width: 1024px) {
  .session-workbench-shell {
    position: absolute;
    inset: 48px 0 0;
    z-index: 20;
    width: 100%;
  }
  .session-workbench__splitter {
    display: none;
  }
  .session-workbench {
    width: 100%;
  }
}
</style>
