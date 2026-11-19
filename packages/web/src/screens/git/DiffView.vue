<script setup lang="ts">
// One file's diff, hunk by hunk. In `unstaged` and `staged` mode each hunk carries its actions, and clicking the
// gutter of changed lines picks just those lines (shift-click picks a range). `readonly` shows the diff only.
import { computed, ref, watch } from 'vue'
import type { GitFileDiff, GitHunk } from '@odin/shared/git'
import { IuButton } from '@/components/Button'
import { IuIcon } from '@/components/Icon'

const props = withDefaults(
  defineProps<{
    diff: GitFileDiff | null
    mode?: 'unstaged' | 'staged' | 'readonly'
    busy?: boolean
  }>(),
  { mode: 'readonly', busy: false },
)
const emit = defineEmits<{
  hunk: [action: 'stage' | 'unstage' | 'discard', hunkId: string, lines: number[] | undefined]
}>()

/** hunk id → picked line indexes */
const picked = ref(new Map<string, Set<number>>())
const anchor = ref<{ hunk: string; index: number } | null>(null)
watch(
  () => props.diff,
  () => {
    picked.value = new Map()
    anchor.value = null
  },
)

function toggle(h: GitHunk, index: number, ev: MouseEvent) {
  if (props.mode === 'readonly' || h.lines[index]!.kind === 'context') return
  const next = new Map(picked.value)
  const set = new Set(next.get(h.id) ?? [])
  if (ev.shiftKey && anchor.value?.hunk === h.id) {
    const [a, b] = [anchor.value.index, index].sort((x, y) => x - y) as [number, number]
    for (let i = a; i <= b; i++) if (h.lines[i]!.kind !== 'context') set.add(i)
  } else if (set.has(index)) set.delete(index)
  else set.add(index)
  anchor.value = { hunk: h.id, index }
  if (set.size) next.set(h.id, set)
  else next.delete(h.id)
  picked.value = next
}

const linesOf = (h: GitHunk) => {
  const set = picked.value.get(h.id)
  return set?.size ? [...set].sort((a, b) => a - b) : undefined
}
const label = (h: GitHunk, verb: string) => {
  const n = picked.value.get(h.id)?.size
  return n ? `${verb} ${n} ${n === 1 ? 'line' : 'lines'}` : `${verb} hunk`
}
const empty = computed(() => !!props.diff && !props.diff.binary && props.diff.hunks.length === 0)
</script>

<template>
  <div class="git-diff">
    <p v-if="!diff" class="git-diff__note">Pick a file to see its changes.</p>
    <p v-else-if="diff.binary" class="git-diff__note">Binary file. No line diff to show.</p>
    <p v-else-if="empty" class="git-diff__note">No changes in this file.</p>
    <template v-else>
      <section v-for="h in diff.hunks" :key="h.id" class="git-diff__hunk" :aria-label="h.header">
        <header class="git-diff__head">
          <span class="git-diff__range"
            >@@ -{{ h.oldStart }},{{ h.oldLines }} +{{ h.newStart }},{{ h.newLines }} @@</span
          >
          <span class="git-diff__section">{{ h.section }}</span>
          <span class="git-diff__grow" />
          <template v-if="mode === 'unstaged'">
            <IuButton
              variant="ghost"
              size="sm"
              :disabled="busy"
              @click="emit('hunk', 'discard', h.id, linesOf(h))"
            >
              <template #icon><IuIcon name="retry" :size="14" /></template>
              {{ picked.get(h.id)?.size ? 'Revert lines' : 'Revert hunk' }}
            </IuButton>
            <IuButton size="sm" :disabled="busy" @click="emit('hunk', 'stage', h.id, linesOf(h))">
              <template #icon><IuIcon name="plus" :size="14" /></template>
              {{ label(h, 'Stage') }}
            </IuButton>
          </template>
          <IuButton
            v-else-if="mode === 'staged'"
            size="sm"
            :disabled="busy"
            @click="emit('hunk', 'unstage', h.id, linesOf(h))"
          >
            <template #icon><IuIcon name="minus" :size="14" /></template>
            {{ label(h, 'Unstage') }}
          </IuButton>
        </header>
        <div class="git-diff__rows" role="table" :aria-label="`Lines ${h.header}`">
          <div
            v-for="(l, i) in h.lines"
            :key="i"
            class="git-diff__row"
            :class="[
              `git-diff__row--${l.kind}`,
              { 'git-diff__row--picked': picked.get(h.id)?.has(i) },
            ]"
            role="row"
          >
            <button
              v-if="mode !== 'readonly' && l.kind !== 'context'"
              type="button"
              class="git-diff__gutter git-diff__gutter--pick"
              :aria-pressed="picked.get(h.id)?.has(i) ?? false"
              :aria-label="`Pick line ${l.newLine ?? l.oldLine}`"
              @click="toggle(h, i, $event)"
            >
              <span>{{ l.oldLine ?? '' }}</span
              ><span>{{ l.newLine ?? '' }}</span>
            </button>
            <span v-else class="git-diff__gutter" role="cell">
              <span>{{ l.oldLine ?? '' }}</span
              ><span>{{ l.newLine ?? '' }}</span>
            </span>
            <span class="git-diff__mark" role="cell">{{
              l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''
            }}</span>
            <code class="git-diff__text" role="cell">{{ l.text }}</code>
          </div>
        </div>
      </section>
      <p v-if="diff.truncated" class="git-diff__note">
        The diff is cut short here; it's too long to show.
      </p>
    </template>
  </div>
</template>

<style scoped>
.git-diff {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  line-height: var(--iu-leading-code);
  background: var(--iu-well);
  min-height: 100%;
}
.git-diff__note {
  margin: 0;
  padding: 16px;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-13);
  color: var(--iu-text-muted);
}
.git-diff__head {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 2px 10px;
  background: var(--iu-well-header);
  border-block: 1px solid var(--iu-hairline);
  font-family: var(--iu-font-sans);
}
.git-diff__range {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-info);
  white-space: nowrap;
}
.git-diff__section {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11-5);
  color: var(--iu-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-diff__grow {
  flex: 1;
}
.git-diff__row {
  display: grid;
  grid-template-columns: 76px 16px 1fr;
  color: var(--iu-text-2);
}
.git-diff__gutter {
  display: grid;
  grid-template-columns: 1fr 1fr;
  padding: 0 6px 0 0;
  margin: 0;
  border: 0;
  font: inherit;
  text-align: right;
  color: var(--iu-text-disabled);
  background: var(--iu-gutter);
  user-select: none;
}
.git-diff__gutter span {
  padding-left: 4px;
}
.git-diff__gutter--pick {
  cursor: pointer;
}
.git-diff__gutter--pick:hover {
  color: var(--iu-text);
}
.git-diff__gutter--pick:focus-visible {
  outline: var(--iu-focus-ring);
  outline-offset: -2px;
}
.git-diff__mark {
  text-align: center;
  color: var(--iu-text-disabled);
}
.git-diff__text {
  font: inherit;
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-right: 12px;
}
.git-diff__row--add {
  background: var(--iu-diff-add-bg);
  color: var(--iu-diff-add-ink);
}
.git-diff__row--add .git-diff__gutter {
  background: var(--iu-diff-add-gutter);
}
.git-diff__row--add .git-diff__mark {
  color: var(--iu-positive);
}
.git-diff__row--del {
  background: var(--iu-diff-remove-bg);
  color: var(--iu-diff-remove-ink);
}
.git-diff__row--del .git-diff__gutter {
  background: var(--iu-diff-remove-gutter);
}
.git-diff__row--del .git-diff__mark {
  color: var(--iu-danger);
}
.git-diff__row--picked .git-diff__gutter {
  box-shadow: inset 2px 0 var(--iu-accent);
  color: var(--iu-text);
}
</style>
