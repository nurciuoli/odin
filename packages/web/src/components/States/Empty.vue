<script setup lang="ts">
// IuEmpty.vue — the design bundle documents this component only through the
// API table + the "Empty · three kinds" mockup section (no embedded SFC
// source), so the template/logic below is a from-scratch, real implementation
// built to that contract.
import { computed } from 'vue'
import { IuIcon } from '@/components/Icon'
import { IuRuneMark } from '@/components/RuneMark'

const props = withDefaults(
  defineProps<{
    /** which of the three empty situations this is — drives icon, tone and the eyebrow label */
    kind?: 'first-run' | 'filtered' | 'cleared'
    title: string
    /** one sentence; use the default slot instead for richer (e.g. mixed-mono) copy */
    body?: string
    /** the quiet Norse line under the title; a stable pick per kind by default, or your own, or false for none */
    proverb?: string | false
    /** show the small kind label under the content; turn off where it only adds noise */
    eyebrow?: boolean
  }>(),
  { kind: 'first-run', eyebrow: true, proverb: undefined },
)

// Paraphrased from the Hávamál. One is picked per title, so a given screen always shows the same line.
const PROVERBS: Record<typeof props.kind, string[]> = {
  'first-run': [
    'Fire is best for the sons of men. Start one.',
    'Moderately wise should each man be. Begin small.',
  ],
  filtered: ['Ask well and you will be answered well.', 'The wise man asks, then looks again.'],
  cleared: ['Deeds live on after the doer. Well done.', 'Praise the day at evening.'],
}

const EYEBROW: Record<typeof props.kind, string> = {
  'first-run': 'first run',
  filtered: 'filtered to nothing',
  cleared: 'cleared · a good outcome',
}

const proverbText = computed(() => {
  if (props.proverb !== undefined) return props.proverb || ''
  const list = PROVERBS[props.kind]
  let h = 0
  for (const ch of props.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return list[h % list.length]
})
const eyebrowText = computed(() => EYEBROW[props.kind])
</script>

<template>
  <div class="iu-empty" :class="`iu-empty--${kind}`">
    <div class="iu-empty__icon">
      <IuIcon v-if="kind === 'cleared'" name="check" :size="20" />
      <IuRuneMark v-else :size="22" />
    </div>
    <div class="iu-empty__title">{{ title }}</div>
    <div v-if="proverbText" class="iu-empty__proverb">{{ proverbText }}</div>
    <div v-if="body || $slots.default" class="iu-empty__body">
      <slot>{{ body }}</slot>
    </div>
    <div v-if="$slots.action" class="iu-empty__action"><slot name="action" /></div>
    <div v-if="eyebrow" class="iu-empty__eyebrow">{{ eyebrowText }}</div>
  </div>
</template>

<style>
.iu-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 12px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface);
  padding: 32px 22px;
}

.iu-empty__icon {
  width: 40px;
  height: 40px;
  border-radius: var(--iu-radius-lg);
  border: 1px dashed var(--iu-border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--iu-text-disabled);
  flex: none;
}

/* the "cleared" kind is a success, not a failure — it earns positive ink,
   never the neutral/dashed-danger treatment the other two kinds share */
.iu-empty--cleared .iu-empty__icon {
  border-color: var(--iu-positive-border);
  color: var(--iu-positive);
}

.iu-empty__title {
  font-family: var(--iu-font-display);
  font-size: 15px;
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text);
}

.iu-empty__proverb {
  font-family: var(--iu-font-serif);
  font-style: italic;
  font-size: var(--iu-font-size-13-5);
  color: var(--iu-text-muted);
  margin-top: -6px;
}

.iu-empty__body {
  font-size: var(--iu-font-size-13-5);
  color: var(--iu-text-2);
  line-height: var(--iu-leading-relaxed);
  max-width: 34ch;
}

.iu-empty__body code,
.iu-empty__body [data-mono] {
  font-family: var(--iu-font-mono);
  color: var(--iu-text);
}

.iu-empty__action {
  margin-top: 4px;
}

.iu-empty__eyebrow {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-disabled);
  margin-top: 4px;
}
</style>
