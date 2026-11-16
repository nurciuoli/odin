<script setup lang="ts">
import { computed } from 'vue'
import { useCopy } from '@/composables/useCopy'
import IuButton from '@/components/Button/Button.vue'
import IuIcon from '@/components/Icon/Icon.vue'
// frame, header and button styles live in CodeBlock.vue; import it for its CSS
import '@/components/CodeBlock/CodeBlock.vue'

export interface DiffLine {
  type: 'context' | 'add' | 'remove'
  oldNum?: number
  newNum?: number
  content: string
}

export interface DiffHunk {
  header?: string
  lines: DiffLine[]
}

const props = withDefaults(
  defineProps<{
    hunks: DiffHunk[]
    filename?: string
    stats?: boolean
    lineNumbers?: boolean
    wrap?: boolean
    copyable?: boolean
    maxHeight?: string
  }>(),
  {
    stats: true,
    lineNumbers: true,
    wrap: true,
    copyable: false,
  },
)

// display uses the true minus sign; the copied patch uses ASCII so it applies
const GLYPH: Record<DiffLine['type'], string> = { add: '+', remove: '−', context: ' ' }
const PATCH: Record<DiffLine['type'], string> = { add: '+', remove: '-', context: ' ' }
const SR: Record<DiffLine['type'], string> = { add: 'Added: ', remove: 'Removed: ', context: '' }

const counts = computed(() => {
  let add = 0
  let remove = 0
  for (const h of props.hunks) {
    for (const l of h.lines) {
      if (l.type === 'add') add++
      else if (l.type === 'remove') remove++
    }
  }
  return { add, remove }
})

const showHeader = computed(() => Boolean(props.filename) || props.stats)

// both gutter columns share one width, sized to the widest line number
const numWidth = computed(() => {
  let max = 0
  for (const h of props.hunks) {
    for (const l of h.lines) max = Math.max(max, l.oldNum ?? 0, l.newNum ?? 0)
  }
  return `calc(${Math.max(2, String(max).length)}ch + 20px)`
})

const cols = computed(() => {
  const content = props.wrap ? 'minmax(0, 1fr)' : 'auto'
  return props.lineNumbers ? `auto 2.5ch ${content}` : `2.5ch ${content}`
})

// the patch text, so a copied diff can be applied as-is
const patchText = computed(() =>
  props.hunks
    .flatMap(h => [
      ...(h.header ? [h.header] : []),
      ...h.lines.map(l => `${PATCH[l.type]}${l.content}`),
    ])
    .join('\n'),
)

const { copied, copy: copyText } = useCopy()
const copy = () => copyText(patchText.value)
</script>

<template>
  <div class="iu-code iu-diff">
    <div v-if="showHeader" class="iu-code__header">
      <span v-if="filename" class="iu-code__name">{{ filename }}</span>
      <span v-if="stats" class="iu-diff__stats">
        <span class="iu-diff__stat iu-diff__stat--add">+{{ counts.add }}</span>
        <span class="iu-diff__stat iu-diff__stat--remove">−{{ counts.remove }}</span>
      </span>
      <div class="iu-code__actions">
        <IuButton
          v-if="copyable"
          variant="ghost"
          size="sm"
          icon-only
          class="iu-code__copy"
          :class="{ 'is-copied': copied }"
          aria-label="Copy diff"
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
        aria-label="Copy diff"
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
        class="iu-code__table iu-diff__table"
        :class="{ 'is-wrap': wrap }"
        :style="{ '--iu-code-cols': cols, '--iu-diff-num': numWidth }"
      >
        <div v-for="(hunk, hi) in hunks" :key="hi" class="iu-diff__hunk">
          <div v-if="hunk.header" class="iu-diff__head">{{ hunk.header }}</div>
          <div
            v-for="(line, li) in hunk.lines"
            :key="li"
            class="iu-code__row iu-diff__row"
            :data-type="line.type"
          >
            <span v-if="lineNumbers" class="iu-diff__gutter">
              <span class="iu-diff__num">{{ line.oldNum ?? '' }}</span>
              <span class="iu-diff__num">{{ line.newNum ?? '' }}</span>
            </span>
            <span class="iu-diff__sign">
              <span aria-hidden="true">{{ GLYPH[line.type] }}</span>
              <span v-if="line.type !== 'context'" class="iu-code__sr">{{ SR[line.type] }}</span>
            </span>
            <span class="iu-code__text">{{ line.content }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
.iu-diff__stats {
  display: inline-flex;
  gap: 8px;
  flex: none;
  font-size: var(--iu-font-size-11-5);
}

.iu-diff__stat--add {
  color: var(--iu-diff-add-ink);
}

.iu-diff__stat--remove {
  color: var(--iu-diff-remove-ink);
}

.iu-diff__head {
  padding: 4px 12px;
  white-space: pre;
  background: var(--iu-well-header);
  border-bottom: 1px solid var(--iu-hairline);
  font-size: var(--iu-font-size-11-5);
  line-height: var(--iu-leading-code);
  color: var(--iu-text-muted);
}

.iu-diff__hunk + .iu-diff__hunk {
  border-top: 1px solid var(--iu-hairline);
}

.iu-diff__gutter {
  position: sticky;
  left: 0;
  z-index: 1;
  display: grid;
  grid-template-columns: var(--iu-diff-num) var(--iu-diff-num);
  background: var(--iu-gutter);
  border-right: 1px solid var(--iu-hairline);
  user-select: none;
}

.iu-diff__num {
  padding: 0 10px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--iu-text-muted);
}

.iu-diff__sign {
  text-align: center;
  user-select: none;
}

.iu-diff__row[data-type='context'] {
  background: transparent;
  color: var(--iu-text-muted);
}

.iu-diff__row[data-type='add'] {
  background: var(--iu-diff-add-bg);
  color: var(--iu-diff-add-ink);
}

.iu-diff__row[data-type='add'] .iu-diff__gutter {
  background: var(--iu-diff-add-gutter);
}

.iu-diff__row[data-type='remove'] {
  background: var(--iu-diff-remove-bg);
  color: var(--iu-diff-remove-ink);
}

.iu-diff__row[data-type='remove'] .iu-diff__gutter {
  background: var(--iu-diff-remove-gutter);
}
</style>
