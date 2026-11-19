<script setup lang="ts">
// IuToaster.vue — mount once at the app root.
import { computed } from 'vue'
import { IuIcon } from '@/components/Icon'
import { glyph, MAX_VISIBLE, useToast } from './useToast'

const { items, dismiss, pause, resume } = useToast()

const visible = computed(() => items.value.slice(0, MAX_VISIBLE))
const overflow = computed(() => Math.max(0, items.value.length - MAX_VISIBLE))
</script>

<template>
  <Teleport to="body">
    <ol class="iu-toaster" aria-live="polite" aria-atomic="false">
      <TransitionGroup name="iu-toast">
        <li
          v-for="t in visible"
          :key="t.id"
          class="iu-toast"
          :class="`iu-toast--${t.intent ?? 'info'}`"
          :role="t.intent === 'danger' ? 'alert' : 'status'"
          @pointerenter="pause(t.id)"
          @pointerleave="resume(t.id)"
        >
          <span class="iu-toast__icon" aria-hidden="true">
            <IuIcon :name="glyph(t.intent)" :size="16" />
          </span>
          <div class="iu-toast__text">
            <p class="iu-toast__title">
              {{ t.title }}<span v-if="t.count > 1" class="iu-toast__count"> ×{{ t.count }}</span>
            </p>
            <p v-if="t.description" class="iu-toast__desc">{{ t.description }}</p>
          </div>
          <button v-if="t.action" class="iu-toast__action" @click="t.action.onClick">
            {{ t.action.label }}
          </button>
          <button class="iu-toast__close" :aria-label="`Dismiss ${t.title}`" @click="dismiss(t.id)">
            <IuIcon name="close" :size="14" />
          </button>
        </li>
      </TransitionGroup>
      <li v-if="overflow > 0" class="iu-toaster__overflow" aria-hidden="true">
        +{{ overflow }} more
      </li>
    </ol>
  </Teleport>
</template>

<style>
.iu-toaster {
  position: fixed;
  z-index: 2000;
  bottom: 20px;
  right: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(360px, calc(100vw - 32px));
  margin: 0;
  padding: 0;
  list-style: none;
}

.iu-toast {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 13px 15px;
  border: 1px solid var(--iu-border-strong);
  border-left: 3px solid var(--iu-text-muted);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-raised);
  box-shadow: var(--iu-shadow-raised);
  pointer-events: auto;
}

.iu-toast--success {
  border-left-color: var(--iu-positive);
}
.iu-toast--success .iu-toast__icon {
  color: var(--iu-positive);
}
.iu-toast--warning {
  border-left-color: var(--iu-warning);
}
.iu-toast--warning .iu-toast__icon {
  color: var(--iu-warning);
}
.iu-toast--danger {
  border-left-color: var(--iu-danger);
}
.iu-toast--danger .iu-toast__icon {
  color: var(--iu-danger);
}
.iu-toast--info {
  border-left-color: var(--iu-info);
}
.iu-toast--info .iu-toast__icon {
  color: var(--iu-info);
}
.iu-toast--progress {
  border-left-color: var(--iu-accent);
}
.iu-toast--progress .iu-toast__icon {
  color: var(--iu-accent);
}

.iu-toast__icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  line-height: var(--iu-leading-normal);
}

.iu-toast__text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.iu-toast__title {
  margin: 0;
  font-size: var(--iu-font-size-14);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}
.iu-toast__count {
  font-weight: var(--iu-font-weight-regular);
  color: var(--iu-text-muted);
}
.iu-toast__desc {
  margin: 0;
  font-size: var(--iu-font-size-13);
  line-height: var(--iu-leading-normal);
  color: var(--iu-text-2);
}

.iu-toast__action {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: var(--iu-font-size-13);
  color: var(--iu-accent);
  cursor: pointer;
}
.iu-toast__action:hover {
  text-decoration: underline;
  text-underline-offset: 3px;
}

.iu-toast__close {
  flex-shrink: 0;
  display: inline-flex;
  border: none;
  background: none;
  padding: 3px;
  border-radius: var(--iu-radius-sm);
  color: var(--iu-text-muted);
  cursor: pointer;
}
.iu-toast__close:hover {
  color: var(--iu-text);
  background: var(--iu-hover);
}

.iu-toaster__overflow {
  text-align: right;
  padding-top: 2px;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}

.iu-toast-move,
.iu-toast-enter-active,
.iu-toast-leave-active {
  transition:
    transform var(--iu-dur-micro) var(--iu-ease),
    opacity var(--iu-dur-micro) var(--iu-ease);
}
.iu-toast-enter-from {
  opacity: 0;
  transform: translateY(var(--iu-rise));
}
.iu-toast-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
.iu-toast-leave-active {
  position: absolute;
  width: min(360px, calc(100vw - 32px));
}
</style>
