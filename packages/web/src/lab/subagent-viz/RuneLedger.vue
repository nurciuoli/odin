<script setup lang="ts">
// Variation C: rune stones. Each subagent carves a row of runes, one per tool call. A carved rune glows steady, the
// one being cut shimmers, a rune the agent is stuck on is ringed and still, and a failed row cracks through.
import { runePaths, toolRune } from './runes'
import { stateColor, stateWord, type Sub } from './mock'

defineProps<{ agents: Sub[] }>()

type Tile = 'pending' | 'carved' | 'cutting' | 'waiting' | 'cracked'
function tile(a: Sub, i: number): Tile {
  if (a.state === 'pending') return 'pending'
  if (a.state === 'done') return 'carved'
  if (a.state === 'failed') return i < a.step ? 'carved' : i === a.step ? 'cracked' : 'pending'
  if (i < a.step) return 'carved'
  if (i === a.step) return a.state === 'waiting' ? 'waiting' : 'cutting'
  return 'pending'
}
</script>

<template>
  <ol class="ledger" aria-label="Subagents as rune stones">
    <li v-for="a in agents" :key="a.id" class="row" :class="a.state">
      <div class="who">
        <span class="name">{{ a.name }}</span>
        <span class="task">{{ a.task }}</span>
      </div>
      <ul class="runes">
        <li v-for="(tool, i) in a.tools" :key="i" class="stone" :class="tile(a, i)" :title="`${tool}: ${tile(a, i)}`">
          <svg viewBox="0 0 24 32" width="22" height="30" aria-hidden="true">
            <path :d="runePaths[toolRune[tool]]" pathLength="1" class="glyph" />
            <path v-if="tile(a, i) === 'cracked'" d="M3 3L21 29" class="crack" />
          </svg>
          <span class="tool">{{ tool }}</span>
        </li>
      </ul>
      <div class="status" :style="{ color: stateColor[a.state] }">
        <span class="word">{{ stateWord[a.state] }}</span>
        <span class="note">{{ a.note }}</span>
      </div>
    </li>
  </ol>
</template>

<style scoped>
.ledger {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 10px;
  font-family: var(--iu-font-sans);
}
.row {
  display: grid;
  grid-template-columns: 170px 1fr 170px;
  align-items: center;
  gap: 16px;
  padding: 10px 14px;
  border: 1px solid var(--iu-hairline);
  border-radius: 10px;
  background: var(--iu-surface-sunken);
}
.row.waiting {
  border-color: var(--iu-warning-border);
}
.row.failed {
  border-color: var(--iu-danger-border);
}
.who {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.name {
  color: var(--iu-text);
  font-size: 13px;
  font-weight: 500;
}
.task {
  color: var(--iu-text-muted);
  font-size: 11px;
}
.runes {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.stone {
  display: grid;
  justify-items: center;
  gap: 3px;
  width: 44px;
  padding: 7px 0 5px;
  border-radius: 7px 7px 3px 3px;
  border: 1px solid var(--iu-border-quiet);
  background: var(--iu-ground);
  color: var(--iu-text-disabled);
}
.glyph {
  fill: none;
  stroke: currentColor;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.crack {
  stroke: var(--iu-danger);
  stroke-width: 1.6;
  stroke-dasharray: 3 2;
  fill: none;
}
.tool {
  font-family: var(--iu-font-mono);
  font-size: 9px;
  color: var(--iu-text-disabled);
}
.stone.carved {
  color: var(--iu-text-2);
  border-color: var(--iu-border);
  background: var(--iu-surface);
}
.done .stone.carved {
  color: var(--iu-positive);
  border-color: var(--iu-positive-border);
  background: var(--iu-positive-wash);
}
.stone.cutting {
  color: var(--iu-info);
  border-color: var(--iu-info-border);
  background: var(--iu-info-wash);
  box-shadow: 0 0 14px -2px var(--iu-info);
}
.stone.waiting {
  color: var(--iu-warning);
  border-color: var(--iu-warning);
  background: var(--iu-warning-wash);
}
.stone.cracked {
  color: var(--iu-danger);
  border-color: var(--iu-danger-border);
  background: var(--iu-danger-wash);
}
.status {
  display: grid;
  gap: 2px;
  text-align: right;
}
.word {
  font-size: 12px;
}
.note {
  font-size: 11px;
  color: var(--iu-text-muted);
}
@media (prefers-reduced-motion: no-preference) {
  .stone.cutting {
    animation: glow 1.6s ease-in-out infinite;
  }
  .stone.cutting .glyph {
    stroke-dasharray: 1;
    animation: carve 1.6s ease-in-out infinite;
  }
}
@keyframes glow {
  50% {
    box-shadow: 0 0 6px -2px var(--iu-info);
  }
}
@keyframes carve {
  0% {
    stroke-dashoffset: 0.55;
  }
  70%,
  100% {
    stroke-dashoffset: 0;
  }
}
@media (max-width: 720px) {
  .row {
    grid-template-columns: 1fr;
  }
  .status {
    text-align: left;
  }
}
</style>
