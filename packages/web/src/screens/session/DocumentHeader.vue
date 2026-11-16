<script setup lang="ts">
// The one header every document wears on the workspace surface: what it is and where it lives, one line of status,
// then its main action, a menu for the rest, and close. A file, a notebook and an artifact differ only in what they
// put in it.
import { computed, inject } from 'vue'
import { IuButton } from '@/components/Button'
import { IuIcon, type IconName } from '@/components/Icon'
import { IuMenu, type MenuItem } from '@/components/Menu'
import { IuStatusDot } from '@/components/StatusDot'
import type { Status } from '@/styles/status'
import { SURFACE } from './surface'

const props = withDefaults(
  defineProps<{
    name: string
    /** The folder it lives in, slash-separated; empty at the top level and for things that are not files. */
    dir?: string
    icon?: IconName
    /** One short line: Saved, Unsaved changes, v2 of 3, Kernel idle. Announced politely when it changes. */
    status?: string
    /** Draws a status dot before the line; the line still says the state in words. */
    tone?: Status | null
    menu?: MenuItem[]
  }>(),
  { dir: '', icon: 'file', status: '', tone: null, menu: () => [] },
)
const emit = defineEmits<{ select: [id: string]; close: [] }>()
const surface = inject(SURFACE, null)
const items = computed<MenuItem[]>(() =>
  surface
    ? [
        ...props.menu,
        ...(props.menu.length ? [{ type: 'separator' as const }] : []),
        { id: 'surface:hide', label: 'Hide panel', icon: 'panelRight' as const },
      ]
    : props.menu,
)
function onSelect(id: string) {
  if (id === 'surface:hide') surface?.hidePanel()
  else emit('select', id)
}
const full = computed(() => (props.dir ? `${props.dir}/${props.name}` : props.name))
</script>

<template>
  <header class="doc-header">
    <IuButton
      v-if="surface"
      variant="ghost"
      size="sm"
      icon-only
      aria-label="Open a file, notebook or output"
      title="Open…"
      aria-haspopup="true"
      :aria-expanded="surface.browsing.value"
      :aria-controls="surface.drawerId"
      @click="surface.toggleBrowse"
    >
      <template #icon><IuIcon name="search" :size="14" /></template>
    </IuButton>
    <IuIcon class="doc-header__icon" :name="icon" :size="14" />
    <h2 class="doc-header__title" :title="full">
      <span v-if="dir" class="doc-header__dir">{{ dir }}/</span
      ><span class="doc-header__name">{{ name }}</span>
    </h2>
    <span class="doc-header__status" role="status" aria-live="polite">
      <IuStatusDot v-if="tone && status" :status="tone" decorative />
      <span>{{ status }}</span>
    </span>
    <div class="doc-header__actions">
      <slot name="actions" />
      <IuMenu v-if="items.length" :items="items" @select="onSelect">
        <template #trigger="{ toggle, open }">
          <IuButton
            variant="ghost"
            size="sm"
            icon-only
            :aria-label="`More actions for ${name}`"
            aria-haspopup="menu"
            :aria-expanded="open"
            @click="toggle"
          >
            <template #icon><IuIcon name="more" :size="14" /></template>
          </IuButton>
        </template>
      </IuMenu>
      <IuButton
        variant="ghost"
        size="sm"
        icon-only
        :aria-label="`Close ${name}`"
        :title="`Close ${name}`"
        @click="emit('close')"
      >
        <template #icon><IuIcon name="close" :size="14" /></template>
      </IuButton>
    </div>
  </header>
</template>

<style>
.doc-header {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 44px;
  box-sizing: border-box;
  padding: 0 8px 0 8px;
  border-bottom: 1px solid var(--iu-border-quiet);
}
.doc-header__icon {
  flex: none;
  color: var(--iu-text-muted);
}
.doc-header__title {
  display: flex;
  min-width: 0;
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
  font-weight: var(--iu-font-weight-regular);
  line-height: var(--iu-leading-snug);
  white-space: nowrap;
}
.doc-header__dir {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--iu-text-muted);
}
.doc-header__name {
  flex: 0 1 auto;
  min-width: 48px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--iu-text);
  font-weight: var(--iu-font-weight-medium);
}
.doc-header__status {
  flex: 0 1 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
  color: var(--iu-text-muted);
  font-size: var(--iu-font-size-12);
  white-space: nowrap;
}
.doc-header__status > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
}
.doc-header__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
</style>
