<script setup lang="ts">
import { computed } from 'vue'
import { useCopy } from '@/composables/useCopy'
import IuButton from '@/components/Button/Button.vue'
import IuIcon from '@/components/Icon/Icon.vue'
import { stripAnsi } from './ansi'

const props = withDefaults(
  defineProps<{
    text: string
    /** The command that produced it, shown as a prompt line. */
    command?: string
    tone?: 'default' | 'error'
    maxHeight?: string
    truncated?: boolean
    /** Joined to a parent terminal surface rather than drawing a second border. */
    embedded?: boolean
  }>(),
  { tone: 'default', maxHeight: '320px', truncated: false, embedded: false },
)

const clean = computed(() => stripAnsi(props.text))
const { copied, copy: copyText } = useCopy()
const copy = () => copyText(clean.value)
</script>

<template>
  <div
    class="iu-terminal-output"
    :class="[`iu-terminal-output--${tone}`, { 'iu-terminal-output--embedded': embedded }]"
  >
    <div class="iu-terminal-output__float">
      <IuButton
        variant="ghost"
        size="sm"
        icon-only
        aria-label="Copy output"
        class="iu-terminal-output__copy"
        @click="copy"
      >
        <template #icon>
          <IuIcon :name="copied ? 'check' : 'copy'" :size="14" />
        </template>
      </IuButton>
    </div>
    <span class="iu-terminal-output__sr" role="status">{{ copied ? 'Copied' : '' }}</span>
    <div class="iu-terminal-output__scroll" tabindex="0" :style="{ maxHeight }">
      <div v-if="command" class="iu-terminal-output__command">
        <span aria-hidden="true">$ </span>{{ command }}
      </div>
      <pre class="iu-terminal-output__text">{{ clean }}</pre>
    </div>
    <p v-if="truncated" class="iu-terminal-output__note">Output truncated.</p>
  </div>
</template>

<style>
.iu-terminal-output {
  position: relative;
  min-width: 0;
  background: var(--iu-well);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-md);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-normal);
  color: var(--iu-text);
}

.iu-terminal-output--error {
  border-color: var(--iu-danger-border);
  color: var(--iu-danger);
}

.iu-terminal-output--embedded {
  border: none;
  border-radius: 0;
}

.iu-terminal-output__float {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 1;
}

.iu-terminal-output__scroll {
  overflow: auto;
  padding: 8px 40px 8px 12px;
}

.iu-terminal-output__scroll:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: calc(var(--iu-focus-offset) * -1);
}

.iu-terminal-output__command {
  color: var(--iu-text-muted);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.iu-terminal-output__text {
  margin: 0;
  font: inherit;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.iu-terminal-output__note {
  margin: 0;
  padding: 4px 12px;
  border-top: 1px solid var(--iu-border);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}

.iu-terminal-output__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
