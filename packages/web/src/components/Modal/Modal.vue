<script setup lang="ts">
import { ref, watch, nextTick, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    placement?: 'center' | 'right' | 'left' | 'bottom'
    size?: 'sm' | 'md' | 'lg' | 'full'
    dismissible?: boolean
  }>(),
  { placement: 'center', size: 'md', dismissible: true },
)

const open = defineModel<boolean>('open', { required: true })
const el = ref<HTMLDialogElement>()

// A dialog mounted already open (a parent's v-if) opens too; the watch below only sees later changes.
onMounted(() => {
  if (open.value) el.value?.showModal()
})
watch(open, async v => {
  await nextTick()
  if (v)
    el.value?.showModal() // native focus trap + inert background
  else el.value?.close()
})

function onCancel(e: Event) {
  if (!props.dismissible) e.preventDefault() // Esc blocked for required flows
}
</script>

<template>
  <dialog
    ref="el"
    class="iu-dialog"
    :class="[`iu-dialog--${placement}`, `iu-dialog--${size}`]"
    @cancel="onCancel"
    @close="open = false"
    @click.self="dismissible && (open = false)"
  >
    <header v-if="$slots.header" class="iu-dialog__header"><slot name="header" /></header>
    <div class="iu-dialog__body"><slot /></div>
    <footer v-if="$slots.footer" class="iu-dialog__footer"><slot name="footer" /></footer>
  </dialog>
</template>

<style>
.iu-dialog {
  border: 1px solid var(--iu-border-strong);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-raised);
  color: var(--iu-text);
  padding: 0;
  box-shadow: var(--iu-shadow-dialog);
}
.iu-dialog::backdrop {
  background: var(--iu-scrim);
}

/* Size variants */
.iu-dialog--sm {
  inline-size: 320px;
}
.iu-dialog--md {
  inline-size: 440px;
}
.iu-dialog--lg {
  inline-size: 640px;
}
.iu-dialog--full {
  inline-size: min(1100px, 92vw);
}

/* Placement variants */
.iu-dialog--right {
  margin-inline-end: 0;
  block-size: 100dvh;
  max-block-size: none;
  border-radius: 0;
  border-inline-end: none;
}

.iu-dialog--left {
  margin-inline-start: 0;
  block-size: 100dvh;
  max-block-size: none;
  border-radius: 0;
  border-inline-start: none;
}

.iu-dialog--bottom {
  margin-block-end: 0;
  inline-size: 100%;
  max-inline-size: none;
  border-radius: 0;
  border-block-end: none;
}

/* Entry animation */
.iu-dialog[open] {
  animation: iu-settle var(--iu-dur-micro) var(--iu-ease);
}

@media (prefers-reduced-motion: reduce) {
  .iu-dialog[open] {
    animation: none;
  }
}

/* Header, body, footer structure */
.iu-dialog__header {
  padding: 18px 20px;
  border-bottom: 1px solid var(--iu-hairline);
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.iu-dialog__body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.iu-dialog__footer {
  padding: 14px 20px;
  border-top: 1px solid var(--iu-hairline);
  background: var(--iu-surface);
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
