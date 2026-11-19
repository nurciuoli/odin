<script setup lang="ts">
// IuAttachment — one file chip. Used inside the composer's attachment row and
// in thread messages. Stateless: the parent owns the Attachment and its status.
import { computed } from 'vue'
import { IuIcon } from '@/components/Icon'
import { IuButton } from '@/components/Button'
import type { Attachment } from './types'

const props = withDefaults(
  defineProps<{
    file: Attachment
    removable?: boolean
  }>(),
  { removable: false },
)

const emit = defineEmits<{
  remove: []
  retry: []
}>()

const status = computed(() => props.file.status ?? 'ready')
const failed = computed(() => status.value === 'failed')
const uploading = computed(() => status.value === 'uploading')
const indeterminate = computed(() => uploading.value && props.file.progress === undefined)

const icon = computed(() => (props.file.kind === 'data' ? 'database' : 'file'))

// keep the extension visible when the name is truncated
const parts = computed(() => {
  const name = props.file.name
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' }
  return { stem: name.slice(0, dot), ext: name.slice(dot) }
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const size = computed(() => (props.file.size === undefined ? '' : formatSize(props.file.size)))
const progressPct = computed(() =>
  Math.round(Math.min(1, Math.max(0, props.file.progress ?? 0)) * 100),
)
</script>

<template>
  <div
    class="iu-attachment"
    :data-status="status"
    :title="failed ? `${file.name} — upload failed` : file.name"
  >
    <IuIcon :name="icon" :size="14" class="iu-attachment__icon" />

    <span class="iu-attachment__name">
      <span class="iu-attachment__stem">{{ parts.stem }}</span
      ><span v-if="parts.ext" class="iu-attachment__ext">{{ parts.ext }}</span>
    </span>

    <span v-if="failed" class="iu-attachment__failed">
      <span class="iu-attachment__glyph" aria-hidden="true">▲</span>
      <IuButton variant="link" size="sm" class="iu-attachment__retry" @click="emit('retry')"
        >Retry</IuButton
      >
    </span>
    <span v-else-if="size" class="iu-attachment__size">{{ size }}</span>

    <button
      v-if="removable"
      type="button"
      class="iu-attachment__remove"
      :aria-label="`Remove ${file.name}`"
      @click="emit('remove')"
    >
      <IuIcon name="close" :size="14" />
    </button>

    <span
      v-if="uploading"
      class="iu-attachment__progress"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="indeterminate ? undefined : progressPct"
      :aria-label="`Uploading ${file.name}`"
    >
      <span
        class="iu-attachment__progress-fill"
        :class="{ 'iu-attachment__progress-fill--indeterminate': indeterminate }"
        :style="indeterminate ? undefined : { width: `${progressPct}%` }"
      />
    </span>
  </div>
</template>

<style>
.iu-attachment {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  box-sizing: border-box;
  max-width: 220px;
  padding: 0 6px 0 8px;
  overflow: hidden;
  border-radius: var(--iu-radius-md);
  border: 1px solid var(--iu-border);
  background: var(--iu-raised);
  color: var(--iu-text);
  font-family: var(--iu-font-sans);
  vertical-align: middle;
}
.iu-attachment[data-status='failed'] {
  border-color: var(--iu-danger-border);
}

.iu-attachment__icon {
  flex-shrink: 0;
  color: var(--iu-text-muted);
}

.iu-attachment__name {
  display: inline-flex;
  min-width: 0;
  font-size: var(--iu-font-size-12);
  white-space: nowrap;
}
.iu-attachment__stem {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iu-attachment__ext {
  flex-shrink: 0;
}

.iu-attachment__size {
  flex-shrink: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  white-space: nowrap;
}

.iu-attachment__failed {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: var(--iu-font-size-11);
}
.iu-attachment__glyph {
  color: var(--iu-danger);
  font-size: var(--iu-font-size-10);
}
.iu-attachment__retry {
  font-size: var(--iu-font-size-11);
}

.iu-attachment__remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: var(--iu-radius-sm);
  background: transparent;
  color: var(--iu-text-muted);
  cursor: pointer;
}
.iu-attachment__remove:hover {
  color: var(--iu-text);
  background: var(--iu-surface);
}
.iu-attachment__remove:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}

.iu-attachment__progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--iu-hairline);
}
.iu-attachment__progress-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 0;
  background: var(--iu-accent);
  transition: width var(--iu-dur) var(--iu-ease);
}
.iu-attachment__progress-fill--indeterminate {
  width: 35%;
  animation: iu-attachment-slide 1.4s linear infinite;
}
@keyframes iu-attachment-slide {
  from {
    left: -35%;
  }
  to {
    left: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .iu-attachment__progress-fill {
    transition: none;
  }
  .iu-attachment__progress-fill--indeterminate {
    animation: none;
    left: 0;
    opacity: 0.5;
  }
}
</style>
