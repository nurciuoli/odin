<script setup lang="ts">
import { computed } from 'vue'
import { useCopy } from '@/composables/useCopy'
import IuButton from '@/components/Button/Button.vue'
import IuIcon from '@/components/Icon/Icon.vue'

// Also the shared frame: Diff.vue imports this file for the .iu-code* rules.
const props = withDefaults(
  defineProps<{
    code: string | object
    language?: string
    filename?: string
    lineNumbers?: boolean
    startLine?: number
    wrap?: boolean
    copyable?: boolean
    header?: boolean
    maxHeight?: string
    intent?: 'neutral' | 'danger'
  }>(),
  {
    // an explicit undefined default stops Vue casting an absent Boolean prop to false
    header: undefined,
    lineNumbers: false,
    startLine: 1,
    wrap: false,
    copyable: true,
    intent: 'neutral',
  },
)

const text = computed(() => {
  const raw =
    typeof props.code === 'string' ? props.code : (JSON.stringify(props.code, null, 2) ?? '')
  // a trailing newline is a file-ending convention, not a blank line to show
  return raw.replace(/\n$/, '')
})
const lines = computed(() => text.value.split('\n'))

// header defaults to on only when there's something to label
const showHeader = computed(() => props.header ?? Boolean(props.filename || props.language))

// the gutter sizes to the widest number so 9 → 10 doesn't shift the code
const cols = computed(() => {
  const digits = String(props.startLine + lines.value.length - 1).length
  const gutter = `calc(${Math.max(2, digits)}ch + 20px)`
  const content = props.wrap ? 'minmax(0, 1fr)' : 'auto'
  return props.lineNumbers ? `${gutter} ${content}` : content
})

const { copied, copy: copyText } = useCopy()
const copy = () => copyText(text.value)
</script>

<template>
  <div class="iu-code" :class="`iu-code--${intent}`">
    <div v-if="showHeader" class="iu-code__header">
      <IuIcon
        v-if="intent === 'danger'"
        name="alert"
        :size="14"
        class="iu-code__alert"
        label="Error"
      />
      <span v-if="filename" class="iu-code__name">{{ filename }}</span>
      <span v-if="language" class="iu-code__lang" :class="{ 'iu-code__lang--solo': !filename }">{{
        language
      }}</span>
      <div class="iu-code__actions">
        <slot name="header-actions" />
        <IuButton
          v-if="copyable"
          variant="ghost"
          size="sm"
          icon-only
          class="iu-code__copy"
          :class="{ 'is-copied': copied }"
          aria-label="Copy code"
          @click="copy"
        >
          <template #icon>
            <IuIcon :name="copied ? 'check' : 'copy'" :size="14" />
          </template>
        </IuButton>
      </div>
    </div>

    <div v-else-if="copyable" class="iu-code__float">
      <IuButton
        variant="ghost"
        size="sm"
        icon-only
        class="iu-code__copy"
        :class="{ 'is-copied': copied }"
        aria-label="Copy code"
        @click="copy"
      >
        <template #icon>
          <IuIcon :name="copied ? 'check' : 'copy'" :size="14" />
        </template>
      </IuButton>
    </div>

    <span class="iu-code__sr" role="status">{{ copied ? 'Copied' : '' }}</span>

    <div class="iu-code__scroll" tabindex="0" :style="maxHeight ? { maxHeight } : undefined">
      <div
        class="iu-code__table iu-code__table--body"
        :class="{ 'is-wrap': wrap }"
        :style="{ '--iu-code-cols': cols }"
      >
        <div v-for="(line, i) in lines" :key="i" class="iu-code__row">
          <span v-if="lineNumbers" class="iu-code__num">{{ startLine + i }}</span>
          <span class="iu-code__text">{{ line }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
/* Frame, header and rows. Diff.vue reuses these classes, so change them with both in mind. */
.iu-code {
  position: relative;
  min-width: 0;
  max-width: 100%;
  border: 1px solid var(--iu-hairline);
  border-radius: var(--iu-radius-md);
  background: var(--iu-well);
  overflow: hidden;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-code);
  color: var(--iu-text-2);
}

.iu-code--danger {
  border-color: var(--iu-danger-border);
  background: var(--iu-danger-wash);
  color: var(--iu-diff-remove-ink);
}

.iu-code__header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 6px 0 12px;
  border-bottom: 1px solid var(--iu-hairline);
  background: var(--iu-well-header);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-none);
  min-width: 0;
}

.iu-code--danger .iu-code__header {
  border-bottom-color: var(--iu-danger-border);
  background: color-mix(in srgb, var(--iu-danger-border) 22%, var(--iu-danger-wash));
}

.iu-code__alert {
  flex: none;
  color: var(--iu-diff-remove-ink);
}

.iu-code__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--iu-text-2);
}

/* language sits after the filename, muted; alone, it is the label */
.iu-code__lang {
  flex: none;
  white-space: nowrap;
  color: var(--iu-text-muted);
}

.iu-code__lang--solo {
  color: var(--iu-text-2);
}

.iu-code__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex: none;
}

/* the copy button floats when there's no header to hold it */
.iu-code__float {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 2;
  padding: 2px;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-well);
  opacity: 0;
  transition: opacity var(--iu-dur-fast) var(--iu-ease);
}

.iu-code:hover .iu-code__float,
.iu-code:focus-within .iu-code__float {
  opacity: 1;
}

@media (hover: none) {
  .iu-code__float {
    opacity: 1;
  }
}

.iu-code__copy.is-copied {
  color: var(--iu-positive);
}

.iu-code__sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* the scroll box is the whole block: horizontal scroll moves every line together */
.iu-code__scroll {
  min-width: 0;
  overflow: auto;
  overscroll-behavior: contain;
}

.iu-code__scroll:focus-visible {
  outline: 1px solid var(--iu-accent);
  outline-offset: -1px;
}

.iu-code__table {
  display: block;
  min-width: 100%;
  width: max-content;
}

.iu-code__table.is-wrap {
  width: 100%;
}

.iu-code__row {
  display: grid;
  grid-template-columns: var(--iu-code-cols);
}

/* the gutter is sticky so numbers stay put while a long line scrolls sideways */
.iu-code__num {
  position: sticky;
  left: 0;
  z-index: 1;
  padding: 0 10px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  background: var(--iu-gutter);
  border-right: 1px solid var(--iu-hairline);
  color: var(--iu-text-muted);
  user-select: none;
}

.iu-code__text {
  min-width: 0;
  min-height: 1.7em; /* empty lines keep their height */
  padding: 0 12px;
  white-space: pre;
}

.iu-code__table.is-wrap .iu-code__text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.iu-code__table--body .iu-code__row:first-child > * {
  padding-top: 10px;
}

.iu-code__table--body .iu-code__row:last-child > * {
  padding-bottom: 10px;
}

.iu-code--danger .iu-code__num {
  background: transparent;
  border-right-color: var(--iu-danger-border);
  color: color-mix(in srgb, var(--iu-diff-remove-ink) 55%, transparent);
}
</style>
