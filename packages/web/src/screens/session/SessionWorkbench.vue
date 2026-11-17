<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { SessionDetail } from '@odin/shared/api'
import { IuButton } from '@/components/Button'
import type SessionFilesType from './SessionFiles.vue'
import type { PreviewView } from './workbench'
const SessionFiles = defineAsyncComponent(() => import('./SessionFiles.vue'))
const props = withDefaults(
  defineProps<{ session: SessionDetail; width: number; resizable?: boolean }>(),
  { resizable: false },
)
const emit = defineEmits<{ close: []; 'update:width': [width: number] }>()
const tab = defineModel<PreviewView>('tab', { required: true })
const filePanel = ref<InstanceType<typeof SessionFilesType>>()
const pendingPath = ref<string | null>(null)
watch(filePanel, panel => {
  if (panel && pendingPath.value !== null) {
    void panel.open(pendingPath.value)
    pendingPath.value = null
  }
})
function openFile(path: string) {
  tab.value = 'files'
  const root = props.session.cwd.replaceAll('\\', '/').replace(/\/$/, '')
  const normalized = path.replaceAll('\\', '/')
  const relative = normalized.startsWith(root + '/')
    ? normalized.slice(root.length + 1)
    : normalized
  if (filePanel.value) void filePanel.value.open(relative)
  else pendingPath.value = relative
}

const MIN_WIDTH = 480
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
const maxWidth = computed(() =>
  Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(availableWidth.value - 360))),
)
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
  if (current && splitter.value?.hasPointerCapture(current.id))
    splitter.value.releasePointerCapture(current.id)
  document.documentElement.classList.remove('session-workbench--resizing')
}
function startDrag(event: PointerEvent) {
  if (event.button !== 0) return
  event.preventDefault()
  drag.value = { id: event.pointerId, startX: event.clientX, startWidth: boundedWidth.value }
  splitter.value?.setPointerCapture(event.pointerId)
  document.documentElement.classList.add('session-workbench--resizing')
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
defineExpose({ openFile })
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
    <div v-if="drag" class="session-workbench__drag-shield" aria-hidden="true" />
    <aside class="session-workbench" :data-tab="tab" aria-label="Content preview">
      <div class="session-workbench__topbar">
        <span>Content preview</span>
        <IuButton variant="ghost" size="sm" aria-label="Close preview" @click="emit('close')"
          >Close preview</IuButton
        >
      </div>
      <div class="session-workbench__content">
        <div v-show="tab === 'files'" class="session-workbench__file-panel">
          <SessionFiles
            :key="session.id"
            ref="filePanel"
            :session="session"
            @hide="emit('close')"
          />
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
  flex: none;
  height: 38px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--iu-border-quiet);
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
}
.session-workbench__content {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
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
  outline: 2px solid var(--iu-accent);
  outline-offset: 2px;
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
