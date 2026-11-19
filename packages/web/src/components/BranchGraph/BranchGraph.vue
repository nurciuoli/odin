<script setup lang="ts">
// Branch graph: the trunk on top, one lane per branch below it, x = order (not time). Lines are drawn in SVG and
// hidden from assistive tech; marks are real HTML on top of it (links when they have `to`), each with a name and a
// tooltip, so keyboard and screen-reader users get the same facts. End state and staleness are words and line
// styles, never colour alone. The graph scrolls sideways; below 640px it becomes a plain list. Nothing animates.
import { computed } from 'vue'
import { branchPath, branchSummary, extent, PAD, ROW, xOf, yOf } from './branchGraph'
import type { BranchIntent, GraphBranch } from './types'

const props = withDefaults(
  defineProps<{
    trunk: string
    branches: GraphBranch[]
    /** Accessible name of the graph. */
    ariaLabel?: string
  }>(),
  { ariaLabel: 'Branches' },
)

const GLYPH: Partial<Record<BranchIntent, string>> = { warning: '!', danger: '×', positive: '✓' }

const width = computed(() => xOf(extent(props.branches)) + PAD)
const height = computed(() => (props.branches.length + 1) * ROW)
const lanes = computed(() =>
  props.branches.map((b, i) => ({
    b,
    lane: i + 1,
    d: branchPath(b, i + 1),
    endX: xOf(b.forkAt + Math.max(1, b.length)),
    mergeX: xOf(b.forkAt + Math.max(1, b.length) + 1),
  })),
)
</script>

<template>
  <div class="iu-branch-graph">
    <div class="iu-branch-graph__wide" role="group" :aria-label="ariaLabel">
      <ul class="iu-branch-graph__names">
        <li class="iu-branch-graph__name" data-trunk="">{{ trunk }}</li>
        <li v-for="l in lanes" :key="l.b.name" class="iu-branch-graph__name" :title="l.b.name">
          {{ l.b.name }}<span class="sr-only">: {{ branchSummary(l.b) }}</span>
        </li>
      </ul>
      <div class="iu-branch-graph__scroll" tabindex="0" :aria-label="`${ariaLabel}, scrollable`">
        <div
          class="iu-branch-graph__canvas"
          :style="{ width: `${width}px`, height: `${height}px` }"
        >
          <svg
            class="iu-branch-graph__svg"
            :width="width"
            :height="height"
            :viewBox="`0 0 ${width} ${height}`"
            aria-hidden="true"
          >
            <line
              class="iu-branch-graph__trunk"
              :x1="PAD"
              :y1="yOf(0)"
              :x2="width - PAD"
              :y2="yOf(0)"
            />
            <g v-for="l in lanes" :key="l.b.name" :data-intent="l.b.intent">
              <path
                class="iu-branch-graph__line"
                :d="l.d"
                :data-dashed="l.b.dashed ? '' : undefined"
              />
              <circle
                v-if="l.b.end === 'merged'"
                class="iu-branch-graph__merge"
                :cx="l.mergeX"
                :cy="yOf(0)"
                r="4"
              />
              <path
                v-else-if="l.b.end === 'open'"
                class="iu-branch-graph__open"
                :d="`M${l.endX + 4} ${yOf(l.lane) - 5} L${l.endX + 10} ${yOf(l.lane)} L${l.endX + 4} ${yOf(l.lane) + 5}`"
              />
            </g>
          </svg>
          <template v-for="l in lanes" :key="l.b.name">
            <component
              :is="m.to ? 'router-link' : 'span'"
              v-for="(m, i) in l.b.marks"
              :key="i"
              :to="m.to"
              :tabindex="m.to ? undefined : 0"
              :role="m.to ? undefined : 'img'"
              class="iu-branch-graph__mark"
              :data-intent="m.intent"
              :aria-label="`${l.b.name}: ${m.label}`"
              :style="{ left: `${xOf(m.at)}px`, top: `${yOf(l.lane)}px` }"
            >
              <span aria-hidden="true" class="iu-branch-graph__glyph">{{ GLYPH[m.intent] }}</span>
              <span aria-hidden="true" class="iu-branch-graph__tip">{{ m.label }}</span>
            </component>
          </template>
        </div>
      </div>
    </div>

    <ul class="iu-branch-graph__list" :aria-label="ariaLabel">
      <li v-for="b in branches" :key="b.name">
        <span class="iu-branch-graph__list-name">{{ branchSummary(b) }}</span>
        <ul v-if="b.marks.length">
          <li v-for="(m, i) in b.marks" :key="i">
            <router-link v-if="m.to" :to="m.to">{{ m.label }}</router-link>
            <span v-else>{{ m.label }}</span>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style>
.iu-branch-graph {
  --iu-branch-row: 32px;
  min-width: 0;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}
.iu-branch-graph__wide {
  display: grid;
  grid-template-columns: minmax(0, 12rem) minmax(0, 1fr);
  gap: 8px;
}
.iu-branch-graph__names {
  list-style: none;
  margin: 0;
  padding: 0;
}
.iu-branch-graph__name {
  height: var(--iu-branch-row);
  line-height: var(--iu-branch-row);
  font-family: var(--iu-font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.iu-branch-graph__name[data-trunk] {
  color: var(--iu-text);
}
.iu-branch-graph__scroll {
  overflow-x: auto;
  overflow-y: hidden;
  border-radius: var(--iu-radius-sm);
}
.iu-branch-graph__scroll:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.iu-branch-graph__canvas {
  position: relative;
}
.iu-branch-graph__svg {
  position: absolute;
  inset: 0;
  overflow: visible;
}
.iu-branch-graph__trunk {
  stroke: var(--iu-text-muted);
  stroke-width: 2;
}
.iu-branch-graph__line,
.iu-branch-graph__open {
  fill: none;
  stroke: var(--iu-branch-ink, var(--iu-text-muted));
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.iu-branch-graph__line[data-dashed] {
  stroke-dasharray: 4 4;
}
.iu-branch-graph__merge {
  fill: var(--iu-surface);
  stroke: var(--iu-branch-ink, var(--iu-text-muted));
  stroke-width: 2;
}
.iu-branch-graph [data-intent='neutral'] {
  --iu-branch-ink: var(--iu-text-muted);
}
.iu-branch-graph [data-intent='accent'] {
  --iu-branch-ink: var(--iu-accent);
}
.iu-branch-graph [data-intent='positive'] {
  --iu-branch-ink: var(--iu-positive);
}
.iu-branch-graph [data-intent='warning'] {
  --iu-branch-ink: var(--iu-warning);
}
.iu-branch-graph [data-intent='danger'] {
  --iu-branch-ink: var(--iu-danger);
}
.iu-branch-graph__mark {
  position: absolute;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: var(--iu-radius-pill);
  background: var(--iu-surface);
  box-shadow: inset 0 0 0 2px var(--iu-branch-ink, var(--iu-text-muted));
  color: var(--iu-branch-ink, var(--iu-text-muted));
  text-decoration: none;
  cursor: default;
}
a.iu-branch-graph__mark {
  cursor: pointer;
}
.iu-branch-graph__mark:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: var(--iu-focus-offset);
}
.iu-branch-graph__glyph {
  font-size: var(--iu-font-size-10-5);
  line-height: var(--iu-leading-none);
  font-weight: var(--iu-font-weight-semibold);
}
.iu-branch-graph__tip {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
  padding: 3px 6px;
  border-radius: var(--iu-radius-sm);
  background: var(--iu-surface-raised);
  box-shadow: 0 0 0 1px var(--iu-hairline);
  color: var(--iu-text);
  white-space: nowrap;
  visibility: hidden;
  pointer-events: none;
}
.iu-branch-graph__mark:hover .iu-branch-graph__tip,
.iu-branch-graph__mark:focus-visible .iu-branch-graph__tip {
  visibility: visible;
}
.iu-branch-graph__list {
  display: none;
  margin: 0;
  padding-left: 1.2em;
}
.iu-branch-graph__list-name {
  font-family: var(--iu-font-mono);
  color: var(--iu-text);
}
@media (max-width: 639px) {
  .iu-branch-graph__wide {
    display: none;
  }
  .iu-branch-graph__list {
    display: block;
  }
}
</style>
