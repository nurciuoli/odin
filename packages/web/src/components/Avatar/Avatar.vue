<script setup lang="ts">
import { computed } from 'vue'
import { IuIcon } from '@/components/Icon'

const props = withDefaults(
  defineProps<{
    name: string
    kind?: 'person' | 'agent' | 'org'
    size?: 20 | 24 | 32 | 40 | 56
    src?: string
    presence?: 'online' | 'idle' | 'running' | 'offline' | null
    id?: string
  }>(),
  { kind: 'person', size: 32, presence: null },
)

const initials = computed(() => {
  const parts = props.name.trim().split(/\s+/)
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
})

// stable hue: same id is the same colour in every view
const HUES = 6
const hue = computed(() => {
  const key = props.id ?? props.name
  let h = 0
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h % HUES
})

// shape is the semantic channel — never colour alone
const radius = computed(
  () => ({ person: '50%', agent: '30%', org: 'var(--iu-radius-sm)' })[props.kind],
)
</script>

<template>
  <span
    class="iu-avatar"
    :class="[`iu-avatar--${kind}`, `iu-avatar--hue-${hue}`]"
    :style="{ '--sz': size + 'px', '--r': radius }"
    :title="name"
  >
    <img v-if="src" :src="src" :alt="name" @error="$emit('imgerror')" />
    <IuIcon v-else-if="kind === 'agent'" name="terminal" :size="size <= 24 ? 14 : 20" />
    <span v-else aria-hidden="true">{{ initials }}</span>
    <span
      v-if="presence && size >= 24"
      class="iu-avatar__presence"
      :class="`is-${presence}`"
      :aria-label="presence"
    />
  </span>
</template>

<style>
.iu-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--sz);
  height: var(--sz);
  border-radius: var(--r);
  flex-shrink: 0;
  position: relative;
  font-family: var(--iu-font-mono);
  font-weight: var(--iu-font-weight-medium);
  font-size: calc(var(--sz) / 2.5);
  overflow: hidden;
}

.iu-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.iu-avatar span:not(.iu-avatar__presence) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}

/* Hues — six stable identity colors */
.iu-avatar--hue-0 {
  background: var(--iu-hue-0-bg);
  color: var(--iu-hue-0-ink);
}
.iu-avatar--hue-1 {
  background: var(--iu-hue-1-bg);
  color: var(--iu-hue-1-ink);
}
.iu-avatar--hue-2 {
  background: var(--iu-hue-2-bg);
  color: var(--iu-hue-2-ink);
}
.iu-avatar--hue-3 {
  background: var(--iu-hue-3-bg);
  color: var(--iu-hue-3-ink);
}
.iu-avatar--hue-4 {
  background: var(--iu-hue-4-bg);
  color: var(--iu-hue-4-ink);
}
.iu-avatar--hue-5 {
  background: var(--iu-hue-5-bg);
  color: var(--iu-hue-5-ink);
}

/* Agent kind overrides hue with ember wash */
.iu-avatar--agent {
  background: var(--iu-agent-bg);
  color: var(--iu-accent);
}

/* Org kind stays neutral and bordered */
.iu-avatar--org {
  background: var(--iu-raised);
  color: var(--iu-text-2);
  border: 1px solid var(--iu-border);
}

.iu-avatar__presence {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: calc(var(--sz) / 3.2);
  height: calc(var(--sz) / 3.2);
  border-radius: 50%;
  border: 2px solid var(--iu-surface);
  box-shadow: 0 0 0 1px var(--iu-ground);
}

.iu-avatar__presence.is-online {
  background: var(--iu-positive);
}
.iu-avatar__presence.is-idle {
  background: var(--iu-text-disabled);
}
.iu-avatar__presence.is-running {
  background: var(--iu-accent);
}
.iu-avatar__presence.is-offline {
  background: var(--iu-text-muted);
}
</style>
