<script setup lang="ts">
// IuPagination.vue — numbered pages for anything you cite or link, load-more
// for feeds and traces where position is meaningless. Counts are always
// mono and comma-grouped.
//
// The API table documents `page` (v-model), `total` and `mode`. Row size is
// implied by the mockup's own "Rows per page" control and the "1–50 of
// 4,812" summary, so `pageSize` (v-model) and `pageSizeOptions` are added
// here as the minimum extra surface needed to make that control work —
// flagged in the build report as an inferred addition, not a literal
// entry in the compressed API grid.
import { computed } from 'vue'
import { IuIcon } from '@/components/Icon'

const props = withDefaults(
  defineProps<{
    total: number
    mode?: 'pages' | 'more'
    pageSizeOptions?: number[]
  }>(),
  {
    mode: 'pages',
    pageSizeOptions: () => [50, 100, 250],
  },
)

const emit = defineEmits<{ 'load-more': [] }>()

const page = defineModel<number>('page', { default: 1 })
const pageSize = defineModel<number>('pageSize', { default: 50 })

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / pageSize.value)))
const rangeStart = computed(() => (props.total === 0 ? 0 : (page.value - 1) * pageSize.value + 1))
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, props.total))
const isExhausted = computed(() => rangeEnd.value >= props.total)

const mono = (n: number) => n.toLocaleString('en-US')

type PageEntry = number | '…'

// classic windowed pager: first, last, current ±2, ellipsis for the gaps
const pageEntries = computed<PageEntry[]>(() => {
  const total = totalPages.value
  const current = page.value
  const delta = 2
  const keep = new Set<number>()
  keep.add(1)
  keep.add(total)
  for (let i = current - delta; i <= current + delta; i++) {
    if (i >= 1 && i <= total) keep.add(i)
  }
  const sorted = [...keep].sort((a, b) => a - b)
  const out: PageEntry[] = []
  let prev: number | undefined
  for (const n of sorted) {
    if (prev !== undefined && n - prev > 1) out.push('…')
    out.push(n)
    prev = n
  }
  return out
})

function goTo(p: number) {
  if (p < 1 || p > totalPages.value || p === page.value) return
  page.value = p
}

function setPageSize(size: number) {
  if (size === pageSize.value) return
  pageSize.value = size
  page.value = 1
}

function loadMore() {
  if (isExhausted.value) return
  page.value += 1
  emit('load-more')
}
</script>

<template>
  <div class="iu-pagination" :class="`iu-pagination--${mode}`">
    <template v-if="mode === 'pages'">
      <span class="iu-pagination__summary"
        >{{ mono(rangeStart) }}–{{ mono(rangeEnd) }} of {{ mono(total) }}</span
      >
      <div class="iu-pagination__pages">
        <button
          type="button"
          class="iu-pagination__nav"
          aria-label="Previous page"
          :disabled="page <= 1"
          @click="goTo(page - 1)"
        >
          <IuIcon name="chevronRight" :size="14" style="transform: rotate(180deg)" />
        </button>
        <template v-for="(entry, i) in pageEntries" :key="i">
          <span v-if="entry === '…'" class="iu-pagination__ellipsis">…</span>
          <button
            v-else
            type="button"
            class="iu-pagination__page"
            :class="{ 'is-current': entry === page }"
            :aria-current="entry === page ? 'page' : undefined"
            @click="goTo(entry)"
          >
            {{ entry }}
          </button>
        </template>
        <button
          type="button"
          class="iu-pagination__nav iu-pagination__nav--next"
          aria-label="Next page"
          :disabled="page >= totalPages"
          @click="goTo(page + 1)"
        >
          <IuIcon name="chevronRight" :size="14" />
        </button>
      </div>
    </template>

    <template v-else>
      <span class="iu-pagination__rows-label">Rows</span>
      <div class="iu-pagination__sizes">
        <button
          v-for="opt in pageSizeOptions"
          :key="opt"
          type="button"
          class="iu-pagination__size"
          :class="{ 'is-current': opt === pageSize }"
          @click="setPageSize(opt)"
        >
          {{ opt }}
        </button>
      </div>
      <button type="button" class="iu-pagination__more" :disabled="isExhausted" @click="loadMore">
        <IuIcon name="arrowDown" :size="14" />
        {{ isExhausted ? 'All loaded' : `Load ${pageSize} more` }}
      </button>
    </template>
  </div>
</template>

<style>
.iu-pagination {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.iu-pagination__summary,
.iu-pagination__rows-label {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}

.iu-pagination__pages {
  display: flex;
  margin-left: auto;
}

.iu-pagination__nav,
.iu-pagination__page,
.iu-pagination__ellipsis {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--iu-border);
  border-right: none;
  background: var(--iu-surface);
  color: var(--iu-text-2);
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
}
.iu-pagination__nav {
  color: var(--iu-text-2);
  cursor: pointer;
}
.iu-pagination__nav:first-child {
  border-radius: var(--iu-radius-sm) 0 0 var(--iu-radius-sm);
}
.iu-pagination__nav--next {
  border-right: 1px solid var(--iu-border);
  border-radius: 0 var(--iu-radius-sm) var(--iu-radius-sm) 0;
}
.iu-pagination__nav:disabled {
  color: var(--iu-text-disabled);
  cursor: not-allowed;
}
.iu-pagination__nav:not(:disabled):hover {
  background: var(--iu-raised);
  color: var(--iu-text);
}

.iu-pagination__page {
  cursor: pointer;
}
.iu-pagination__page:hover {
  background: var(--iu-raised);
  color: var(--iu-text);
}
.iu-pagination__page.is-current {
  background: var(--iu-raised);
  color: var(--iu-text);
}

.iu-pagination__ellipsis {
  color: var(--iu-text-disabled);
}

.iu-pagination__sizes {
  display: flex;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  overflow: hidden;
}
.iu-pagination__size {
  height: 28px;
  padding: 0 10px;
  border: none;
  border-left: 1px solid var(--iu-border);
  background: var(--iu-surface);
  color: var(--iu-text-2);
  cursor: pointer;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
}
.iu-pagination__size:first-child {
  border-left: none;
}
.iu-pagination__size:hover {
  color: var(--iu-text);
}
.iu-pagination__size.is-current {
  background: var(--iu-raised);
  color: var(--iu-text);
}

.iu-pagination__more {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 11px;
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
  background: var(--iu-surface);
  color: var(--iu-text-2);
  cursor: pointer;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  margin-left: auto;
}
.iu-pagination__more:not(:disabled):hover {
  border-color: var(--iu-border-strong);
  color: var(--iu-text);
}
.iu-pagination__more:disabled {
  color: var(--iu-text-disabled);
  cursor: not-allowed;
}
</style>
