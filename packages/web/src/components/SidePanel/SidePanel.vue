<script setup lang="ts">
import { computed, useSlots, useTemplateRef } from 'vue'
import IuButton from '@/components/Button/Button.vue'
import IuEyebrow from '@/components/Eyebrow/Eyebrow.vue'
import IuIcon from '@/components/Icon/Icon.vue'

const props = withDefaults(
  defineProps<{
    width?: number
    title?: string
    eyebrow?: string
    closable?: boolean
    ariaLabel?: string
    presentation?: 'inline' | 'overlay'
    /**
     * `column`: a full-height app column. The header is the 48px band IuHeader draws, so it lines up with the
     * neighbouring column headers, and the body has no padding: the content (an iframe, a list) fills it edge to edge.
     * `compact`: a 36px header with a quiet divider, the height of a section header such as a file browser's, so the
     * two dividers line up when they sit side by side. Its title is one line; the body keeps its padding.
     */
    variant?: 'default' | 'column' | 'compact'
  }>(),
  { width: 320, closable: true, presentation: 'inline', variant: 'default' },
)

const open = defineModel<boolean>('open', { default: true })
const emit = defineEmits<{ close: [] }>()
const slots = useSlots()
const overlay = computed(() => props.presentation === 'overlay')
const closeBtn = useTemplateRef<{ $el: HTMLElement }>('closeBtn')
const aside = useTemplateRef<HTMLElement>('aside')

// the panel never moves focus itself: the consumer restores it on `close`
function close() {
  if (!open.value) return
  open.value = false
  emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.closable && !e.defaultPrevented) close()
}

function onScrim() {
  if (props.closable) close()
}

// for a consumer that opened the panel with the user's own action
function focus() {
  const target = closeBtn.value?.$el ?? aside.value
  target?.focus()
}

defineExpose({ focus })
</script>

<template>
  <aside
    ref="aside"
    class="iu-side-panel"
    :class="{
      'is-closed': !open,
      'iu-side-panel--overlay': overlay,
      'iu-side-panel--column': variant === 'column',
      'iu-side-panel--compact': variant === 'compact',
    }"
    :style="{ '--iu-side-panel-w': `${width}px` }"
    :inert="!open"
    :role="overlay ? 'dialog' : undefined"
    :tabindex="overlay ? -1 : undefined"
    :aria-label="ariaLabel ?? title"
    @keydown="onKeydown"
  >
    <div v-if="overlay" class="iu-side-panel__scrim" aria-hidden="true" @click="onScrim" />
    <div class="iu-side-panel__inner">
      <header
        v-if="title || eyebrow || slots.header || slots.actions || closable"
        class="iu-side-panel__header"
      >
        <div class="iu-side-panel__heading">
          <slot v-if="slots.header" name="header" />
          <template v-else>
            <IuEyebrow v-if="eyebrow" size="sm">{{ eyebrow }}</IuEyebrow>
            <h2 v-if="title" class="iu-side-panel__title">{{ title }}</h2>
          </template>
        </div>
        <div class="iu-side-panel__actions">
          <slot name="actions" />
          <IuButton
            v-if="closable"
            ref="closeBtn"
            variant="ghost"
            size="sm"
            icon-only
            aria-label="Close panel"
            @click="close"
          >
            <template #icon><IuIcon name="close" :size="14" /></template>
          </IuButton>
        </div>
      </header>

      <div class="iu-side-panel__body">
        <slot />
      </div>

      <footer v-if="slots.footer" class="iu-side-panel__footer">
        <slot name="footer" />
      </footer>
    </div>
  </aside>
</template>

<style>
/* The width animates on the outer box; the inner keeps its full width so content never reflows mid-slide. */
.iu-side-panel {
  flex: none;
  box-sizing: border-box;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  width: var(--iu-side-panel-w);
  border-left: 1px solid var(--iu-hairline);
  background: var(--iu-ground);
  transition: width var(--iu-dur) var(--iu-ease);
}
.iu-side-panel.is-closed {
  width: 0;
  border-left-width: 0;
}
.iu-side-panel__inner {
  display: flex;
  flex-direction: column;
  width: calc(var(--iu-side-panel-w) - 1px);
  height: 100%;
}

/* Overlay: the aside is a transparent layer over the consumer's positioned container.
   Only the scrim and the inner surface take pointer events, so the content under the
   layer stays usable when the panel is closed. */
.iu-side-panel.iu-side-panel--overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  width: auto;
  height: auto;
  border-left: 0;
  background: none;
  transition: none;
  pointer-events: none;
}
.iu-side-panel--overlay:focus {
  outline: none;
}
.iu-side-panel--overlay .iu-side-panel__scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--iu-well) 60%, transparent);
  pointer-events: auto;
  transition: opacity var(--iu-dur) var(--iu-ease);
}
.iu-side-panel--overlay .iu-side-panel__inner {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  box-sizing: border-box;
  width: min(var(--iu-side-panel-w), 100% - 48px);
  border-left: 1px solid var(--iu-hairline);
  background: var(--iu-raised);
  box-shadow: var(--iu-shadow-raised);
  pointer-events: auto;
  /* visibility flips at once on open (focus() needs it), and only after the slide on close */
  transition:
    transform var(--iu-dur) var(--iu-ease),
    visibility 0s;
}
.iu-side-panel--overlay .iu-side-panel__footer {
  background: var(--iu-raised);
}
.iu-side-panel--overlay.is-closed .iu-side-panel__scrim {
  opacity: 0;
  pointer-events: none;
}
.iu-side-panel--overlay.is-closed .iu-side-panel__inner {
  transform: translateX(100%);
  visibility: hidden;
  transition:
    transform var(--iu-dur) var(--iu-ease),
    visibility 0s linear var(--iu-dur);
}

.iu-side-panel__header {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  box-sizing: border-box;
  min-height: 52px;
  padding: 12px 10px 12px 16px;
  border-bottom: 1px solid var(--iu-hairline);
}
.iu-side-panel__heading {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.iu-side-panel__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-semibold);
  line-height: var(--iu-leading-snug);
  color: var(--iu-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.iu-side-panel__actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}

.iu-side-panel__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 14px 16px 18px;
}

.iu-side-panel__footer {
  flex: none;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--iu-hairline);
  background: var(--iu-ground);
}

/* Column: the header is a 48px band like IuHeader's; the body is flush. */
.iu-side-panel--column .iu-side-panel__header {
  align-items: center;
  height: 48px;
  min-height: 0;
  padding: 0 8px 0 14px;
  border-bottom-color: var(--iu-border-quiet);
}
.iu-side-panel--column .iu-side-panel__heading {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.iu-side-panel--column .iu-side-panel__actions {
  gap: 4px;
}
.iu-side-panel--column .iu-side-panel__body {
  overflow: hidden;
  gap: 0;
  padding: 0;
}

/* Compact: a 36px header, the height of a file browser's section header, with the same quiet divider. */
.iu-side-panel--compact .iu-side-panel__header {
  align-items: center;
  height: 36px;
  min-height: 0;
  padding: 0 6px 0 16px;
  border-bottom-color: var(--iu-border-quiet);
}
.iu-side-panel--compact .iu-side-panel__heading {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.iu-side-panel--compact .iu-side-panel__title {
  -webkit-line-clamp: 1;
  line-height: var(--iu-leading-snug);
}
.iu-side-panel--compact .iu-side-panel__actions {
  gap: 4px;
}

@media (prefers-reduced-motion: reduce) {
  .iu-side-panel,
  .iu-side-panel--overlay .iu-side-panel__scrim,
  .iu-side-panel--overlay .iu-side-panel__inner {
    transition: none;
  }
}
</style>
