<script setup lang="ts">
// A flat treemap of files or folders: cell area is `value`. Items that carry added/removed lines are tinted green,
// red or split between the two, the rest are shaded by their share of the biggest item. Used wherever a list of
// files can be shown as a heatmap instead (session Changes, the session file browser).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { lean, tintPercent } from '@/screens/project/files/files'
import { treemap } from '@/screens/project/files/treemap'

export interface HeatItem {
  id: string
  label: string
  value: number
  folder?: boolean
  /** Tooltip and accessible name; defaults to the label. */
  title?: string
  /** Short text shown in the cell when it is big enough ("+12 −3"). */
  note?: string
  added?: number
  removed?: number
  /** Lines in the file now, to judge how much of it changed; defaults to what changed. */
  lines?: number
}

const props = withDefaults(
  defineProps<{
    items: HeatItem[]
    /** Names the group for assistive tech. */
    label: string
    height?: number
    selectedId?: string
  }>(),
  { height: 180, selectedId: undefined },
)
const emit = defineEmits<{ select: [id: string] }>()

const GAP = 2
const box = ref<HTMLElement | null>(null)
const width = ref(0)
let observer: ResizeObserver | undefined
const measure = () => {
  if (box.value) width.value = box.value.clientWidth
}
watch(
  box,
  el => {
    observer?.disconnect()
    observer = undefined
    if (!el) return
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(measure)
      observer.observe(el)
    }
  },
  { flush: 'post', immediate: true },
)
onBeforeUnmount(() => observer?.disconnect())

const peak = computed(() => Math.max(1, ...props.items.map(i => i.value)))
const cells = computed(() => {
  const byId = new Map(props.items.map(i => [i.id, i]))
  return treemap(
    props.items.map(i => ({ id: i.id, value: Math.max(1, i.value) })),
    width.value,
    props.height,
  )
    .map(r => ({ item: byId.get(r.id)!, x: r.x, y: r.y, w: r.w - GAP, h: r.h - GAP }))
    .filter(c => c.w >= 1 && c.h >= 1)
})

function background(i: HeatItem): string | undefined {
  const raised = 'var(--iu-surface-raised)'
  if (i.added || i.removed) {
    const d = {
      added: i.added ?? 0,
      removed: i.removed ?? 0,
      lines: i.lines ?? (i.added ?? 0) + (i.removed ?? 0),
    }
    const s = Math.max(25, tintPercent(d))
    const add = `color-mix(in srgb, var(--iu-positive) ${s}%, ${raised})`
    const rem = `color-mix(in srgb, var(--iu-danger) ${s}%, ${raised})`
    const l = lean(d)
    if (l.kind === 'add') return add
    if (l.kind === 'remove') return rem
    return `linear-gradient(90deg, ${add} ${l.addPercent}%, ${rem} ${l.addPercent}%)`
  }
  if (i.folder) return 'var(--iu-surface-sunken)'
  const share = Math.round((i.value / peak.value) * 40)
  return `color-mix(in srgb, var(--iu-text-muted) ${share}%, ${raised})`
}
</script>

<template>
  <div
    ref="box"
    class="file-heatmap"
    role="group"
    :aria-label="label"
    :style="{ height: `${height}px` }"
  >
    <button
      v-for="c in cells"
      :key="c.item.id"
      type="button"
      class="file-heatmap__cell"
      :class="{ 'file-heatmap__cell--selected': c.item.id === selectedId }"
      :style="{
        left: `${c.x + GAP / 2}px`,
        top: `${c.y + GAP / 2}px`,
        width: `${c.w}px`,
        height: `${c.h}px`,
        background: background(c.item),
      }"
      :title="c.item.title ?? c.item.label"
      :aria-label="c.item.title ?? c.item.label"
      @click="emit('select', c.item.id)"
    >
      <span v-if="c.w > 44 && c.h > 20" class="file-heatmap__name">{{ c.item.label }}</span>
      <span v-if="c.item.note && c.w > 56 && c.h > 38" class="file-heatmap__note">{{
        c.item.note
      }}</span>
    </button>
  </div>
</template>

<style>
.file-heatmap {
  position: relative;
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--iu-border-quiet);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-surface-sunken);
  overflow: hidden;
}
.file-heatmap__cell {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: space-between;
  padding: 4px 6px;
  border: 0;
  overflow: hidden;
  color: var(--iu-text);
  font-family: var(--iu-font-sans);
  text-align: left;
  cursor: pointer;
}
.file-heatmap__cell:hover {
  box-shadow: inset 0 0 0 1px var(--iu-border-strong);
}
.file-heatmap__cell--selected,
.file-heatmap__cell--selected:hover {
  box-shadow: inset 0 0 0 2px var(--iu-accent);
}
.file-heatmap__cell:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: calc(var(--iu-focus-offset) * -1);
}
.file-heatmap__name {
  width: 100%;
  overflow: hidden;
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-tight);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-heatmap__note {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
}
</style>
