<script setup lang="ts">
import { computed } from 'vue'
import IuIcon from '@/components/Icon/Icon.vue'

const props = defineProps<{
  text: string
  durationMs?: number
  streaming?: boolean
}>()

const open = defineModel<boolean>('open', { default: false })

function toggle() {
  open.value = !open.value
}

const label = computed(() => {
  if (props.streaming) return 'Thinking…'
  if (props.durationMs === undefined) return 'Thought for a moment'
  return `Thought for ${Math.max(1, Math.round(props.durationMs / 1000))}s`
})
</script>

<template>
  <div class="iu-thinking">
    <button type="button" class="iu-thinking__head" :aria-expanded="open" @click="toggle">
      <!-- chevron first, same column as IuToolGroup's, so stacked rows in a turn align -->
      <IuIcon name="chevronRight" :size="14" class="iu-thinking__chevron" />
      <IuIcon name="sparkle" :size="14" class="iu-thinking__icon" />
      <span class="iu-thinking__label" :class="{ 'iu-thinking__label--live': streaming }">{{
        label
      }}</span>
    </button>

    <!-- the tail of the text, bottom-anchored, so the newest words stay visible while streaming -->
    <div v-if="streaming && !open" class="iu-thinking__preview" aria-hidden="true">
      <span class="iu-thinking__preview-text">{{ text }}</span>
    </div>

    <div v-if="open" class="iu-thinking__full">{{ text }}</div>
  </div>
</template>

<style>
.iu-thinking {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* same metrics as IuToolGroup's header so a thought and a tool group line up in a stack */
.iu-thinking__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  margin: 0 -8px;
  padding: 0 8px;
  box-sizing: border-box;
  background: none;
  border: none;
  border-radius: var(--iu-radius-sm);
  color: var(--iu-text-2);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  text-align: left;
  cursor: pointer;
  min-width: 0;
}

.iu-thinking__head:hover {
  color: var(--iu-text);
  background: var(--iu-hover);
}

.iu-thinking__head:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}

.iu-thinking__icon {
  flex: none;
  color: var(--iu-text-muted);
}

.iu-thinking__label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* the shimmer is a highlight sweeping through the label, not a colour change */
.iu-thinking__label--live {
  background: linear-gradient(
    90deg,
    var(--iu-text-muted) 0%,
    var(--iu-text) 50%,
    var(--iu-text-muted) 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: iu-thinking-shimmer 1.6s linear infinite;
}

@keyframes iu-thinking-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .iu-thinking__label--live {
    background: none;
    color: var(--iu-text-2);
    animation: none;
  }
}

.iu-thinking__chevron {
  flex: none;
  color: var(--iu-text-muted);
  transition: transform var(--iu-dur) var(--iu-ease);
}

.iu-thinking__head[aria-expanded='true'] .iu-thinking__chevron {
  transform: rotate(90deg);
}

@media (prefers-reduced-motion: reduce) {
  .iu-thinking__chevron {
    transition: none;
  }
}

/* two lines tall; a column-reverse box pins the end of the text to the bottom edge
   and lets the start overflow upward, where the fade hides it */
.iu-thinking__preview {
  display: flex;
  flex-direction: column-reverse;
  max-height: calc(1.5em * 2);
  overflow: hidden;
  margin: 2px 0 0 6px;
  padding-left: 12px;
  font-size: var(--iu-font-size-12-5);
  line-height: var(--iu-leading-normal);
  color: var(--iu-text-muted);
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, var(--iu-text) 1.5em);
  mask-image: linear-gradient(to bottom, transparent 0, var(--iu-text) 1.5em);
}

.iu-thinking__preview-text {
  display: block;
  min-width: 0;
  overflow-wrap: anywhere;
}

.iu-thinking__full {
  margin: 4px 0 0 6px;
  padding-left: 12px;
  border-left: 1px solid var(--iu-hairline);
  font-size: var(--iu-font-size-13);
  line-height: var(--iu-leading-relaxed);
  color: var(--iu-text-2);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
