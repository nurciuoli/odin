<script setup lang="ts">
// IuAttachment — one file chip. Used inside the composer's attachment row and
// in thread messages. Stateless: the parent owns the Attachment and its status.
import { computed, ref, watch } from 'vue'
import { IuIcon } from '@/components/Icon'
import { IuButton } from '@/components/Button'
import { IuDialog } from '@/components/Modal'
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
const canPreview = computed(
  () => !failed.value && !!(props.file.src || props.file.text || props.file.previewUrl),
)
const previewOpen = ref(false)
const thumbFailed = ref(false)
const previewText = ref('')
const previewImage = ref('')
const previewError = ref('')
const previewLoading = ref(false)

watch(
  () => props.file.src,
  () => {
    thumbFailed.value = false
  },
)

watch(previewOpen, async open => {
  if (!open) return
  previewError.value = ''
  previewImage.value = props.file.src ?? ''
  previewText.value = props.file.text ?? ''
  if (previewImage.value || previewText.value || !props.file.previewUrl) return
  previewLoading.value = true
  try {
    const res = await fetch(props.file.previewUrl)
    if (!res.ok) throw new Error(`Preview failed (${res.status})`)
    const type = res.headers.get('content-type') ?? ''
    if (type.startsWith('image/')) previewImage.value = props.file.previewUrl
    else previewText.value = await res.text()
  } catch (err) {
    previewError.value = err instanceof Error ? err.message : 'Could not open this file'
  } finally {
    previewLoading.value = false
  }
})
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
    :class="{ 'iu-attachment--preview': canPreview && !!file.src && !thumbFailed }"
    :data-status="status"
    :title="failed ? `${file.name} — upload failed` : file.name"
  >
    <button
      v-if="canPreview"
      type="button"
      class="iu-attachment__open"
      :aria-label="`Preview ${file.name}`"
      @click="previewOpen = true"
    >
      <img
        v-if="file.src && !thumbFailed"
        class="iu-attachment__thumb"
        :src="file.src"
        alt=""
        @error="thumbFailed = true"
      />
      <IuIcon v-else :name="icon" :size="14" class="iu-attachment__icon" />
      <span class="iu-attachment__name">
        <span class="iu-attachment__stem">{{ parts.stem }}</span
        ><span v-if="parts.ext" class="iu-attachment__ext">{{ parts.ext }}</span>
      </span>
    </button>
    <template v-else>
      <IuIcon :name="icon" :size="14" class="iu-attachment__icon" />
      <span class="iu-attachment__name">
        <span class="iu-attachment__stem">{{ parts.stem }}</span
        ><span v-if="parts.ext" class="iu-attachment__ext">{{ parts.ext }}</span>
      </span>
    </template>

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

    <IuDialog v-if="canPreview" v-model:open="previewOpen" size="full">
      <template #header>
        <h2 class="iu-attachment__title">{{ file.name }}</h2>
        <IuButton
          variant="ghost"
          size="sm"
          icon-only
          aria-label="Close preview"
          @click="previewOpen = false"
        >
          <template #icon><IuIcon name="close" :size="14" /></template>
        </IuButton>
      </template>
      <p v-if="previewLoading" class="iu-attachment__status" role="status">Loading preview…</p>
      <p v-else-if="previewError" class="iu-attachment__status" role="alert">{{ previewError }}</p>
      <img
        v-else-if="previewImage"
        class="iu-attachment__full"
        :src="previewImage"
        :alt="file.name"
      />
      <pre v-else-if="previewText" class="iu-attachment__text">{{ previewText }}</pre>
      <p v-else class="iu-attachment__status">This file can't be previewed.</p>
    </IuDialog>
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
.iu-attachment--preview {
  height: auto;
  max-width: 240px;
  padding: 6px;
  align-items: stretch;
}
.iu-attachment--preview:hover {
  border-color: var(--iu-border-strong);
}

.iu-attachment__open {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.iu-attachment--preview .iu-attachment__open {
  flex-direction: column;
  align-items: stretch;
}
.iu-attachment__open:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: 2px;
}
.iu-attachment__thumb {
  display: block;
  width: 100%;
  max-height: 160px;
  object-fit: contain;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-surface);
}
.iu-attachment__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-medium);
  overflow-wrap: anywhere;
}
.iu-attachment__full {
  display: block;
  max-width: 100%;
  max-height: min(70dvh, 800px);
  margin: 0 auto;
  object-fit: contain;
}
.iu-attachment__text {
  margin: 0;
  max-height: min(70dvh, 800px);
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
.iu-attachment__status {
  margin: 0;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-13);
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
