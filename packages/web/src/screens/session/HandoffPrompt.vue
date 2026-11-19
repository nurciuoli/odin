<script setup lang="ts">
// Bare `/handoff`: a one-line-per-harness card in the message box's place. ↑↓ (or 1–9) pick the harness, ←/→ or Tab
// cycle through that harness's models, Enter hands off, Esc cancels. The server writes the briefing and starts the
// new session. Opening it moves focus here on purpose: the user just asked for it.
import { computed, nextTick, onMounted, ref, useId, useTemplateRef, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { HarnessInfo, ModelInfo } from '@odin/shared/api'
import { useApi } from '@/api'
import { IuButton } from '@/components/Button'
import { IuEyebrow } from '@/components/Eyebrow'
import { IuIcon } from '@/components/Icon'
import { IuStatusDot } from '@/components/StatusDot'
import { useToast } from '@/components/Toast'
import { closeHandoff } from './handoff'

const props = defineProps<{ sessionId: string; harness: string }>()

const api = useApi()
const router = useRouter()
const { toast } = useToast()
const uid = useId()
const root = useTemplateRef<HTMLElement>('root')

const choices = ref<HarnessInfo[]>([])
const selected = ref(0)
/** Models per harness id, loaded when a row is first selected. `null` model index 0 is the harness default. */
const models = ref<Record<string, ModelInfo[]>>({})
const modelAt = ref<Record<string, number>>({})
const busy = ref(false)

const target = computed(() => choices.value[selected.value])
const modelList = (id: string) => models.value[id] ?? []
/** −1 is the harness default; otherwise an index into its model list. */
const modelIndex = (id: string) => modelAt.value[id] ?? -1
const modelLabel = (id: string) =>
  modelIndex(id) < 0
    ? 'Default model'
    : (modelList(id)[modelIndex(id)]?.displayName ?? 'Default model')

function fail(title: string, e?: unknown) {
  toast({
    title,
    description: e instanceof Error ? e.message : e ? String(e) : undefined,
    intent: 'warning',
  })
  closeHandoff()
}

async function loadModels(id: string) {
  if (models.value[id]) return
  try {
    models.value = { ...models.value, [id]: await api.listModels(id) }
  } catch {
    models.value = { ...models.value, [id]: [] } // the default still works
  }
}

watch(target, t => {
  if (t) void loadModels(t.id)
})

onMounted(async () => {
  try {
    choices.value = (await api.getSettings()).harnesses.filter(
      h => h.id !== props.harness && h.available,
    )
  } catch (e) {
    return fail('Couldn’t load the harnesses', e)
  }
  if (!choices.value.length) return fail('No other harness is available here')
  void loadModels(choices.value[0]!.id)
  await nextTick() // the card renders once the harnesses are in
  root.value?.focus()
})

function cycle(step: 1 | -1) {
  const t = target.value
  if (!t) return
  const n = modelList(t.id).length
  if (!n) return
  // −1 (default), 0 … n−1, wrapping
  const next = ((modelIndex(t.id) + 1 + step + (n + 1)) % (n + 1)) - 1
  modelAt.value = { ...modelAt.value, [t.id]: next }
}

function move(step: 1 | -1) {
  const n = choices.value.length
  selected.value = (selected.value + step + n) % n
}

async function go() {
  const t = target.value
  if (!t || busy.value) return
  busy.value = true
  const m = modelIndex(t.id) < 0 ? undefined : modelList(t.id)[modelIndex(t.id)]?.value
  try {
    const s = await api.handoffSession(props.sessionId, {
      harness: t.id,
      ...(m ? { model: m } : {}),
    })
    closeHandoff()
    void router.push(`/s/${s.id}`)
  } catch (e) {
    busy.value = false
    fail('Couldn’t hand off', e)
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.altKey || e.metaKey || e.ctrlKey) return
  const k = e.key
  const handled =
    k === 'ArrowDown' ||
    k === 'ArrowUp' ||
    k === 'ArrowRight' ||
    k === 'ArrowLeft' ||
    k === 'Tab' ||
    k === 'Enter' ||
    k === 'Escape' ||
    (/^[1-9]$/.test(k) && Number(k) <= choices.value.length)
  if (!handled) return
  e.preventDefault()
  if (k === 'ArrowDown') move(1)
  else if (k === 'ArrowUp') move(-1)
  else if (k === 'ArrowRight') cycle(1)
  else if (k === 'ArrowLeft') cycle(-1)
  else if (k === 'Tab') cycle(e.shiftKey ? -1 : 1)
  else if (k === 'Enter') void go()
  else if (k === 'Escape') closeHandoff()
  else selected.value = Number(k) - 1
}
</script>

<template>
  <section
    v-if="choices.length"
    ref="root"
    class="handoff-card"
    tabindex="-1"
    role="group"
    aria-label="Hand off this session to another harness"
    :aria-busy="busy"
    @keydown="onKeydown"
  >
    <div class="handoff-card__top">
      <IuStatusDot status="awaiting" :size="7" decorative />
      <IuEyebrow>Hand off to</IuEyebrow>
      <span class="handoff-card__hint">↑↓ harness · ←→ model · Enter go · Esc cancel</span>
    </div>

    <div class="handoff-card__rows" role="radiogroup" :aria-label="'Harness'">
      <div
        v-for="(h, i) in choices"
        :key="h.id"
        class="handoff-card__row"
        :class="{ 'is-selected': i === selected }"
        role="radio"
        :aria-checked="i === selected"
        :aria-describedby="`${uid}-${h.id}`"
        @click="selected = i"
        @dblclick="go"
      >
        <kbd class="handoff-card__key" aria-hidden="true">{{ i + 1 }}</kbd>
        <span class="handoff-card__name">{{ h.name }}</span>
        <span :id="`${uid}-${h.id}`" class="handoff-card__model">
          <button
            v-if="i === selected && modelList(h.id).length"
            type="button"
            class="handoff-card__step"
            tabindex="-1"
            aria-label="Previous model"
            :disabled="busy"
            @click.stop="cycle(-1)"
          >
            <IuIcon name="chevronLeft" :size="14" />
          </button>
          <span class="handoff-card__modelname">{{ modelLabel(h.id) }}</span>
          <button
            v-if="i === selected && modelList(h.id).length"
            type="button"
            class="handoff-card__step"
            tabindex="-1"
            aria-label="Next model"
            :disabled="busy"
            @click.stop="cycle(1)"
          >
            <IuIcon name="chevronRight" :size="14" />
          </button>
        </span>
      </div>
    </div>

    <div class="handoff-card__actions">
      <IuButton variant="ghost" size="sm" :disabled="busy" @click="closeHandoff">Cancel</IuButton>
      <IuButton variant="primary" size="sm" :loading="busy" @click="go">Hand off</IuButton>
    </div>
    <span class="sr-only" role="status" aria-live="polite"
      >{{ target?.name }}, {{ target ? modelLabel(target.id) : '' }}</span
    >
  </section>
</template>

<style>
.handoff-card {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 10px 12px;
  background: var(--iu-surface);
  border: 1px solid var(--iu-info-border);
  border-left: 3px solid var(--iu-info);
  border-radius: var(--iu-radius-lg);
}
.handoff-card:focus-visible {
  outline: 2px solid var(--iu-focus-ring, var(--iu-info));
  outline-offset: 2px;
}
.handoff-card__top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.handoff-card__hint {
  margin-left: auto;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  white-space: nowrap;
}
.handoff-card__rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.handoff-card__row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  padding: 2px 8px;
  border-radius: var(--iu-radius-md);
  cursor: pointer;
}
.handoff-card__row:hover {
  background: var(--iu-hover);
}
.handoff-card__row.is-selected {
  background: var(--iu-surface-sunken);
}
.handoff-card__key {
  flex: none;
  box-sizing: border-box;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: 500 var(--iu-font-size-11) / 1 var(--iu-font-mono);
  color: var(--iu-text-muted);
  border: 1px solid var(--iu-border);
  border-radius: var(--iu-radius-sm);
}
.handoff-card__row.is-selected .handoff-card__key {
  color: var(--iu-text);
  border-color: var(--iu-border-strong);
}
.handoff-card__name {
  font-size: var(--iu-font-size-13);
  font-weight: var(--iu-font-weight-medium);
  color: var(--iu-text-2);
}
.handoff-card__row.is-selected .handoff-card__name {
  color: var(--iu-text);
}
.handoff-card__model {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.handoff-card__row.is-selected .handoff-card__model {
  color: var(--iu-text-2);
}
.handoff-card__modelname {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.handoff-card__step {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 2px;
  color: inherit;
  background: none;
  border: 0;
  border-radius: var(--iu-radius-sm);
  cursor: pointer;
}
.handoff-card__step:hover {
  color: var(--iu-text);
  background: var(--iu-hover);
}
.handoff-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
</style>
