<script setup lang="ts">
import { computed } from 'vue'
import IuAvatar from './Avatar.vue'

interface StackItem {
  name: string
  kind?: 'person' | 'agent' | 'org'
  src?: string
  id?: string
}

const props = withDefaults(
  defineProps<{
    items: StackItem[]
    max?: number
    size?: 20 | 24 | 32 | 40 | 56
  }>(),
  { max: 3, size: 32 },
)

const shown = computed(() => props.items.slice(0, props.max))
const overflow = computed(() => Math.max(0, props.items.length - props.max))

// every name stays in the accessible label, even the ones hidden behind "+N"
const label = computed(() => props.items.map(item => item.name).join(', ') || undefined)
</script>

<template>
  <div class="iu-avatar-stack" role="group" :aria-label="label" :style="{ '--sz': size + 'px' }">
    <IuAvatar
      v-for="(item, i) in shown"
      :key="item.id || item.name"
      :size="size"
      :name="item.name"
      :kind="item.kind"
      :src="item.src"
      :id="item.id"
      class="iu-avatar-stack__item"
      :style="{ zIndex: shown.length - i }"
    />
    <span v-if="overflow > 0" class="iu-avatar-stack__overflow">+{{ overflow }}</span>
  </div>
</template>

<style>
/* Overlap is 20% of the avatar: enough to read as a stack, little enough that
   the covered avatar keeps its initials clear of the ring. First avatar on top. */
.iu-avatar-stack {
  display: inline-flex;
  align-items: center;
  gap: 0;
}

.iu-avatar-stack__item {
  box-shadow: 0 0 0 2px var(--iu-avatar-ring, var(--iu-surface));
}

.iu-avatar-stack__item + .iu-avatar-stack__item,
.iu-avatar-stack__overflow {
  margin-left: calc(var(--sz) * -0.2);
}

.iu-avatar-stack__overflow {
  position: relative;
  z-index: 0;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--sz);
  height: var(--sz);
  border-radius: 50%;
  background: var(--iu-raised);
  border: 1px solid var(--iu-border);
  color: var(--iu-text-2);
  font-family: var(--iu-font-mono);
  font-size: min(var(--iu-font-size-10-5), calc(var(--sz) / 2.2));
  font-weight: var(--iu-font-weight-medium);
  white-space: nowrap;
  box-shadow: 0 0 0 2px var(--iu-avatar-ring, var(--iu-surface));
}
</style>
