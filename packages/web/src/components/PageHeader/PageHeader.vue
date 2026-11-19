<script setup lang="ts">
import { computed, useSlots } from 'vue'
import IuIcon from '@/components/Icon/Icon.vue'
import IuEyebrow from '@/components/Eyebrow/Eyebrow.vue'
import type { IconName } from '@/components/Icon'

export type PageHeaderTone = 'accent' | 'neutral'

const props = withDefaults(
  defineProps<{
    title: string
    subtitle?: string
    eyebrow?: string
    icon?: IconName
    monogram?: string // 1–3 chars
    tone?: PageHeaderTone
    titleTag?: string
    as?: string
    divider?: boolean
    wrap?: boolean
  }>(),
  { tone: 'accent', titleTag: 'h1', as: 'header', divider: false, wrap: false },
)

const slots = useSlots()
const hasTile = computed(() => Boolean(props.icon || props.monogram || slots.icon))
const hasEyebrow = computed(() => Boolean(props.eyebrow || slots.eyebrow))
</script>

<template>
  <component
    :is="as"
    class="iu-page-header"
    :class="{
      'iu-page-header--divider': divider,
      'iu-page-header--wrap': wrap,
      'iu-page-header--eyebrow': hasEyebrow,
    }"
  >
    <div class="iu-page-header__main">
      <div v-if="hasTile" :class="['iu-page-header__tile', `iu-page-header__tile--${tone}`]">
        <slot name="icon">
          <IuIcon v-if="icon" :name="icon" :size="20" />
          <span v-else class="iu-page-header__monogram">{{ monogram }}</span>
        </slot>
      </div>

      <div class="iu-page-header__text">
        <div class="iu-page-header__head">
          <IuEyebrow v-if="hasEyebrow" class="iu-page-header__eyebrow">
            <slot name="eyebrow">{{ eyebrow }}</slot>
          </IuEyebrow>
          <div class="iu-page-header__titleline">
            <component :is="titleTag" class="iu-page-header__title">{{ title }}</component>
            <span v-if="$slots.status" class="iu-page-header__status"><slot name="status" /></span>
          </div>
        </div>
        <div v-if="subtitle || $slots.subtitle" class="iu-page-header__subtitle">
          <slot name="subtitle">{{ subtitle }}</slot>
        </div>
      </div>
    </div>

    <div v-if="$slots.meta || $slots.actions" class="iu-page-header__aside">
      <div v-if="$slots.meta" class="iu-page-header__meta"><slot name="meta" /></div>
      <div v-if="$slots.actions" class="iu-page-header__actions"><slot name="actions" /></div>
    </div>

    <div v-if="$slots.below" class="iu-page-header__below"><slot name="below" /></div>
  </component>
</template>

<style>
.iu-page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 12px;
  margin: 0;
  min-width: 0;
}

.iu-page-header--divider {
  padding-bottom: 12px;
  border-bottom: 1px solid var(--iu-hairline);
}

.iu-page-header__main {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex: 1 1 0;
  min-width: 0;
}

.iu-page-header__tile {
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: var(--iu-radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.iu-page-header__tile--accent {
  background: var(--iu-accent-wash);
  color: var(--iu-accent);
}

.iu-page-header__tile--neutral {
  background: var(--iu-raised);
  border: 1px solid var(--iu-border);
  color: var(--iu-text-2);
}

.iu-page-header__monogram {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-13);
  letter-spacing: 0.02em;
}

.iu-page-header__text {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.iu-page-header__head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.iu-page-header__titleline {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.iu-page-header__title {
  margin: 0;
  min-width: 0;
  font-family: var(--iu-font-display);
  font-size: 21px;
  font-weight: var(--iu-font-weight-medium);
  line-height: var(--iu-leading-tight);
  letter-spacing: -0.01em;
  color: var(--iu-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* wrap: the title may take several lines; the row keeps at least 60% for it,
   so the aside drops below the title block instead of squeezing it */
.iu-page-header--wrap .iu-page-header__main {
  flex: 1 1 60%;
}

.iu-page-header--wrap .iu-page-header__title {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
  text-wrap: balance;
  overflow-wrap: anywhere;
}

.iu-page-header--wrap .iu-page-header__aside {
  margin-left: 0;
}

/* the aside starts at the title's first line, below the eyebrow */
.iu-page-header--eyebrow.iu-page-header--wrap .iu-page-header__aside {
  margin-top: 18px;
}

.iu-page-header__status {
  flex: none;
  display: inline-flex;
}

.iu-page-header__subtitle {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
  min-width: 0;
  overflow-wrap: anywhere;
}

.iu-page-header__aside {
  flex: none;
  margin-left: auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 18px;
  max-width: 100%;
}

.iu-page-header__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 18px;
}

.iu-page-header__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.iu-page-header__below {
  flex: 1 0 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
