<script setup lang="ts">
// The project page's docked panel, the same pattern as the session screen's preview pane: it sits on the right of
// the Overview, resizes from its left edge (drag or arrow keys), hides, and can go full screen. Its tabs hold the
// project's sections (files with a browser and preview, sessions, outputs, resources, settings) at full detail.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PREVIEW_MIN, maxPreviewWidth } from '@/app/layout'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'
import { IuTabs, type Tab } from '@/components/Tabs'

const props = withDefaults(
  defineProps<{ tabs: Tab[]; width: number; resizable?: boolean; label?: string }>(),
  { resizable: true, label: 'Project panel' },
)
const emit = defineEmits<{ close: []; 'update:width': [width: number] }>()
const tab = defineModel<string>('tab', { required: true })
const full = defineModel<boolean>('full', { default: false })

const MIN_WIDTH = PREVIEW_MIN
const MAX_WIDTH = 1100
const shell = ref<HTMLElement>()
const availableWidth = ref(typeof window === 'undefined' ? 1600 : window.innerWidth)
let observer: ResizeObserver | undefined
function measure() {
  availableWidth.value = shell.value?.parentElement?.clientWidth || window.innerWidth
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && full.value) full.value = false
}
onMounted(() => {
  measure()
  window.addEventListener('resize', measure)
  window.addEventListener('keydown', onKey)
  if (typeof ResizeObserver !== 'undefined' && shell.value?.parentElement) {
    observer = new ResizeObserver(measure)
    observer.observe(shell.value.parentElement)
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', measure)
  window.removeEventListener('keydown', onKey)
  observer?.disconnect()
})
const maxWidth = computed(() => maxPreviewWidth(availableWidth.value, MAX_WIDTH))
const boundedWidth = computed(() => Math.min(props.width, maxWidth.value))

const splitter = ref<HTMLElement>()
const drag = ref<{ id: number; startX: number; startWidth: number } | null>(null)
function stopDrag() {
  const current = drag.value
  drag.value = null
  window.removeEventListener('pointerup', onWindowPointer)
  window.removeEventListener('pointercancel', onWindowPointer)
  if (current && splitter.value?.hasPointerCapture(current.id))
    splitter.value.releasePointerCapture(current.id)
  document.documentElement.classList.remove('project-workbench--resizing')
}
function onWindowPointer(event: PointerEvent) {
  if (drag.value?.id === event.pointerId) stopDrag()
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  drag.value = { id: event.pointerId, startX: event.clientX, startWidth: boundedWidth.value }
  splitter.value?.setPointerCapture(event.pointerId)
  document.documentElement.classList.add('project-workbench--resizing')
  window.addEventListener('pointerup', onWindowPointer)
  window.addEventListener('pointercancel', onWindowPointer)
}
const clamp = (w: number) => Math.max(MIN_WIDTH, Math.min(maxWidth.value, w))
function moveDrag(event: PointerEvent) {
  const current = drag.value
  if (!current || current.id !== event.pointerId) return
  emit('update:width', clamp(current.startWidth + current.startX - event.clientX))
}
function keyResize(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Home') emit('update:width', MIN_WIDTH)
  else if (event.key === 'End') emit('update:width', maxWidth.value)
  else
    emit(
      'update:width',
      clamp(boundedWidth.value + (event.key === 'ArrowLeft' ? 16 : -16) * (event.shiftKey ? 4 : 1)),
    )
}
watch(
  () => props.resizable,
  value => {
    if (!value) stopDrag()
  },
)
onBeforeUnmount(stopDrag)
</script>

<template>
  <div
    ref="shell"
    class="project-workbench-shell"
    :data-full="full || undefined"
    :style="{ '--project-workbench-width': `${boundedWidth}px` }"
  >
    <div
      v-if="resizable && !full"
      ref="splitter"
      class="project-workbench__splitter"
      role="separator"
      aria-label="Resize project panel"
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
    <aside class="project-workbench" :data-tab="tab" :aria-label="label">
      <div class="project-workbench__topbar">
        <IuButton
          v-if="!full"
          variant="ghost"
          size="sm"
          icon-only
          aria-label="Hide panel"
          title="Hide panel"
          @click="emit('close')"
        >
          <template #icon><IuIcon name="panelRight" :size="14" /></template>
        </IuButton>
        <span class="project-workbench__spacer" />
        <IuButton
          variant="ghost"
          size="sm"
          icon-only
          :aria-label="full ? 'Exit full screen' : 'Full screen'"
          :title="full ? 'Exit full screen (Esc)' : 'Full screen'"
          :aria-pressed="full"
          @click="full = !full"
        >
          <template #icon><IuIcon :name="full ? 'minimize' : 'maximize'" :size="14" /></template>
        </IuButton>
      </div>
      <IuTabs
        v-model="tab"
        class="project-workbench__tabs"
        :tabs="tabs"
        :panels="false"
        id-base="project-panel"
        aria-label="Project sections"
      />
      <div
        :id="`project-panel-panel-${tab}`"
        class="project-workbench__content"
        role="tabpanel"
        :aria-labelledby="`project-panel-tab-${tab}`"
      >
        <div v-if="drag" class="project-workbench__drag-shield" aria-hidden="true" />
        <slot />
      </div>
    </aside>
  </div>
</template>

<style>
.project-workbench-shell {
  position: relative;
  flex: none;
  width: var(--project-workbench-width);
  min-height: 0;
  min-width: 0;
  display: flex;
}
.project-workbench-shell[data-full] {
  position: fixed;
  inset: 0;
  z-index: 40;
  width: auto;
}
.project-workbench {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--iu-border-quiet);
  background: var(--iu-ground);
}
.project-workbench__topbar {
  flex: none;
  height: 38px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px 0 8px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.project-workbench__spacer {
  flex: 1 1 0;
}
.project-workbench__tabs {
  flex: none;
  padding: 0 6px;
}
.project-workbench__content {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.project-workbench__splitter {
  position: relative;
  z-index: 3;
  flex: none;
  width: 8px;
  margin-right: -4px;
  cursor: col-resize;
  touch-action: none;
}
.project-workbench__splitter::after {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: transparent;
}
.project-workbench__splitter:hover::after,
.project-workbench__splitter:focus-visible::after {
  background: var(--iu-border-quiet);
}
.project-workbench__splitter:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.project-workbench__drag-shield {
  position: absolute;
  z-index: 2;
  inset: 0;
  cursor: col-resize;
}
.project-workbench--resizing,
.project-workbench--resizing * {
  cursor: col-resize !important;
  user-select: none !important;
}
@media (max-width: 1024px) {
  .project-workbench-shell {
    position: absolute;
    inset: 0;
    z-index: 20;
    width: 100%;
  }
  .project-workbench__splitter {
    display: none;
  }
}
</style>
