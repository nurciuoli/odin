<script setup lang="ts">
// IuComposer — the chat input. The textarea is the whole surface: keyboard
// rules (send / newline / stop / slash menu) live in onKeydown so they read in
// one place. Slash-command state is derived from text + caret, not stored.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { IuIcon } from '@/components/Icon'
import { IuButton } from '@/components/Button'
import { IuMenu, type MenuItem as AddMenuItem } from '@/components/Menu'
import { modelMenu } from './modelMenu'
import EffortSegments from './EffortSegments.vue'
import { effortTone } from './effortScale'
import { IuMeter } from '@/components/Meter'
import IuAttachment from '@/components/Chat/Attachment.vue'
import type { IconName } from '@/components/Icon/icons'
import type {
  Attachment,
  ComposerCommand,
  ComposerCommandChoice,
  ComposerFileMatch,
  ModelOption,
} from '@/components/Chat/types'
import {
  filterCommands,
  insertChoice,
  insertCommand,
  insertMention,
  latestDebounced,
  mentionToken,
  slashToken,
} from './composerMenus'

const FILE_SEARCH_DEBOUNCE_MS = 120

const props = withDefaults(
  defineProps<{
    placeholder?: string
    busy?: boolean
    disabled?: boolean
    models?: ModelOption[]
    commands?: ComposerCommand[]
    context?: { used: number; max: number }
    maxRows?: number
    minRows?: number
    autofocus?: boolean
    /** false drops Attachments from the + menu and ignores pasted or dropped files */
    attachable?: boolean
    /** More entries for the + menu, after Attachments. A pick is emitted as `action`. */
    actions?: AddMenuItem[]
    /** Shift+Tab in the textarea emits `cycle` (and keeps focus) instead of moving focus back */
    cycleOnShiftTab?: boolean
    /** work is in progress but messages are still accepted: an empty draft shows Stop in the send spot, typing brings Send back */
    stoppable?: boolean
    /** the Stop request is in flight */
    stopping?: boolean
    /** accessible name and tooltip of the Stop button */
    stopLabel?: string
    /** Share the enclosing ComposerSurface border when activity is present. */
    embedded?: boolean
    /** backs the `@` file menu: `@` at the start or after a space looks up paths (debounced, newest wins) */
    searchFiles?: (query: string) => Promise<ComposerFileMatch[]>
    /** accessible name of the textarea (two composers on one screen need different names) */
    label?: string
    /** ⌘↵ / Ctrl+↵ emits `submitAlt` (a second way to send, e.g. "start in background") instead of `submit` */
    altSubmit?: boolean
  }>(),
  {
    placeholder: 'Message the agent…',
    busy: false,
    disabled: false,
    maxRows: 10,
    minRows: 1,
    autofocus: false,
    attachable: true,
    cycleOnShiftTab: false,
    stoppable: false,
    stopping: false,
    stopLabel: 'Stop',
    embedded: false,
    altSubmit: false,
    label: 'Message',
  },
)

const text = defineModel<string>({ default: '' })
const attachments = defineModel<Attachment[]>('attachments', { default: () => [] })
// named modelId, not model: a v-model called "model" shares the modelModifiers prop with the default v-model
const model = defineModel<string>('modelId')
// the chosen effort level of the current model (null: Auto). Only used when the model's option lists `effortLevels`.
const effort = defineModel<string | null>('effort', { default: null })

const emit = defineEmits<{
  /** `alt` is set when ⌥↵ / Alt+↵ sent it, for screens that give that combination a meaning of their own */
  submit: [payload: { text: string; attachments: Attachment[]; model?: string; alt?: boolean }]
  /** ⌘↵ / Ctrl+↵ while `altSubmit` is set: the same payload, the same draft clearing */
  submitAlt: [payload: { text: string; attachments: Attachment[]; model?: string }]
  stop: []
  attach: [files: File[]]
  /** an entry from `actions` was picked in the + menu */
  action: [id: string]
  command: [command: ComposerCommand]
  /** a failed attachment's Retry was pressed — the parent owns the upload */
  retry: [file: Attachment]
  /** Shift+Tab pressed in the textarea while `cycleOnShiftTab` is set */
  cycle: []
}>()

const uid = crypto.randomUUID().slice(0, 8)
const textarea = ref<HTMLTextAreaElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const cmdList = ref<HTMLElement | null>(null)

const caret = ref(0)
const slashDismissed = ref(false)
const dragging = ref(false)
let dragDepth = 0

// ── send gating ────────────────────────────────────────────────────────────
const uploading = computed(() => attachments.value.some(a => a.status === 'uploading'))
const hasContent = computed(() => text.value.trim().length > 0 || attachments.value.length > 0)
const canSend = computed(
  () => !props.disabled && !props.busy && !uploading.value && hasContent.value,
)
// busy: Stop replaces Send outright. stoppable: Stop only while there is nothing to send.
const showStop = computed(() => props.busy || (props.stoppable && !hasContent.value))

function submit(how: 'plain' | 'mod' | 'alt' = 'plain') {
  if (!canSend.value) return
  const payload = {
    text: text.value.trim(),
    attachments: [...attachments.value],
    model: model.value,
  }
  if (how === 'mod' && props.altSubmit) emit('submitAlt', payload)
  else emit('submit', how === 'alt' ? { ...payload, alt: true } : payload)
  text.value = ''
  attachments.value = []
  caret.value = 0
  nextTick(() => {
    autosize()
    textarea.value?.focus()
  })
}

// ── autogrow ───────────────────────────────────────────────────────────────
function autosize() {
  const el = textarea.value
  if (!el) return
  el.style.height = 'auto'
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 14 * 1.5
  const max = lineHeight * props.maxRows
  const min = lineHeight * Math.max(1, Math.min(props.minRows, props.maxRows))
  el.style.height = `${Math.max(min, Math.min(el.scrollHeight, max))}px`
  el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden'
}

function updateCaret() {
  caret.value = textarea.value?.selectionStart ?? 0
}

// ── menus: `/` commands, a command's argument choices, `@` files ────────────
// One listbox at a time, derived from text + caret (the pure logic is in composerMenus.ts).
const choiceFor = ref<ComposerCommand | null>(null)
const argHint = ref<{ prefix: string; hint: string } | null>(null)
const fileResults = ref<{ query: string; matches: ComposerFileMatch[] } | null>(null)

const slash = computed(() => slashToken(text.value, caret.value))
const mention = computed(() =>
  props.searchFiles && !slash.value ? mentionToken(text.value, caret.value) : null,
)
const hasMenus = computed(() => !!props.commands?.length || !!props.searchFiles)

interface MenuItem {
  id: string
  label: string
  argument?: string
  description?: string
  group?: string
  icon: IconName
  pick: () => void
}

const menu = computed<{ kind: string; label: string; items: MenuItem[] } | null>(() => {
  if (slashDismissed.value) return null
  const c = choiceFor.value
  if (c && text.value === `/${c.name} ` && caret.value === text.value.length) {
    return {
      kind: `choices-${c.id}`,
      label: `Options for /${c.name}`,
      items: (c.choices ?? []).map((ch, i) => ({
        id: `choice-${i}`,
        label: ch.label,
        argument: ch.insert.trim() || undefined,
        description: ch.hint,
        icon: 'chevronRight' as IconName,
        pick: () => chooseChoice(c, ch),
      })),
    }
  }
  const s = slash.value
  if (s) {
    const items = filterCommands(props.commands ?? [], s.query).map(cmd => ({
      id: `cmd-${cmd.id}`,
      label: `/${cmd.name}`,
      argument: cmd.argumentHint || undefined,
      description: cmd.description,
      group: cmd.group,
      icon: cmd.icon ?? ('slash' as IconName),
      pick: () => chooseCommand(cmd),
    }))
    return items.length ? { kind: 'commands', label: 'Commands', items } : null
  }
  const m = mention.value
  const r = fileResults.value
  if (m && r && r.query === m.query && r.matches.length) {
    return {
      kind: 'files',
      label: 'Files',
      items: r.matches.map((f, i) => ({
        id: `file-${i}`,
        label: f.kind === 'directory' ? `${f.path}/` : f.path,
        icon: (f.kind === 'directory' ? 'folder' : 'file') as IconName,
        pick: () => chooseFile(f),
      })),
    }
  }
  return null
})

const activeIndex = ref(0)
const menuOpen = computed(() => !!menu.value)
const activeItem = computed(() => menu.value?.items[activeIndex.value])
const activeCmdId = computed(() =>
  activeItem.value ? `${uid}-opt-${activeItem.value.id}` : undefined,
)

// rows in display order, split where the group changes
const sections = computed(() => {
  const out: { group?: string; rows: { item: MenuItem; index: number }[] }[] = []
  menu.value?.items.forEach((item, index) => {
    const last = out[out.length - 1]
    if (last && last.group === item.group) last.rows.push({ item, index })
    else out.push({ group: item.group, rows: [{ item, index }] })
  })
  return out
})

watch(
  () => [menu.value?.kind, slash.value?.query, mention.value?.query, fileResults.value],
  () => {
    activeIndex.value = 0
  },
  { immediate: true },
)

function moveActive(delta: number) {
  const n = menu.value?.items.length ?? 0
  if (n) activeIndex.value = (activeIndex.value + delta + n) % n
}

// keep the keyboard-active row in view inside the scroll window
watch(activeIndex, () => {
  nextTick(() =>
    cmdList.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }),
  )
})

const fileSearch = latestDebounced(
  (q: string) => (props.searchFiles ? props.searchFiles(q) : Promise.resolve([])),
  FILE_SEARCH_DEBOUNCE_MS,
  (matches, query) => {
    fileResults.value = { query, matches }
  },
  () => {
    fileResults.value = null
  },
)
watch(
  () => mention.value?.query,
  q => {
    if (q === undefined) {
      fileSearch.cancel()
      fileResults.value = null
    } else fileSearch.call(q)
  },
)
onBeforeUnmount(() => fileSearch.cancel())

function setText(next: { text: string; caret: number }) {
  text.value = next.text
  caret.value = next.caret
  nextTick(() => {
    const el = textarea.value
    if (!el) return
    el.focus()
    el.setSelectionRange(next.caret, next.caret)
    caret.value = next.caret
  })
}

function chooseCommand(cmd: ComposerCommand) {
  const s = slash.value
  if (!s) return
  setText(insertCommand(text.value, s, cmd))
  choiceFor.value = cmd.choices?.length ? cmd : null
  argHint.value = null
  emit('command', cmd)
}

function chooseChoice(cmd: ComposerCommand, choice: ComposerCommandChoice) {
  const next = insertChoice(cmd, choice)
  choiceFor.value = null
  setText(next)
  argHint.value = next.hint ? { prefix: next.text, hint: next.hint } : null
}

function chooseFile(match: ComposerFileMatch) {
  const m = mention.value
  if (!m) return
  setText(insertMention(text.value, m, match))
}

const shownArgHint = computed(() =>
  argHint.value && text.value === argHint.value.prefix ? argHint.value : null,
)

// ── keyboard ───────────────────────────────────────────────────────────────
function onKeydown(e: KeyboardEvent) {
  // IME composition: Enter confirms a candidate, it is not a send
  if (e.isComposing) return

  if (menuOpen.value) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveActive(1)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveActive(-1)
      return
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault()
      activeItem.value?.pick()
      return
    }
    // Escape closes the menu only — the agent keeps running
    if (e.key === 'Escape') {
      e.preventDefault()
      slashDismissed.value = true
      return
    }
  }

  if (e.key === 'Tab' && e.shiftKey && props.cycleOnShiftTab) {
    e.preventDefault()
    emit('cycle')
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit(e.metaKey || e.ctrlKey ? 'mod' : e.altKey ? 'alt' : 'plain')
    return
  }
  if (e.key === 'Escape' && props.busy) {
    e.preventDefault()
    emit('stop')
  }
}

// ── attachments ────────────────────────────────────────────────────────────
function openPicker() {
  fileInput.value?.click()
}

const addItems = computed<AddMenuItem[]>(() => [
  ...(props.attachable
    ? [{ id: 'attach', label: 'Attachments', icon: 'paperclip' as IconName }]
    : []),
  ...(props.actions ?? []),
])
function pickAdd(id: string) {
  if (id === 'attach') openPicker()
  else emit('action', id)
}

function onPicked(e: Event) {
  const el = e.target as HTMLInputElement
  const files = Array.from(el.files ?? [])
  el.value = '' // allow picking the same file again
  if (files.length) emit('attach', files)
}

function removeAttachment(id: string) {
  attachments.value = attachments.value.filter(a => a.id !== id)
}

function onPaste(e: ClipboardEvent) {
  const files = Array.from(e.clipboardData?.files ?? [])
  if (!files.length || props.disabled || !props.attachable) return
  // files with no accompanying text: stop the browser inserting a filename
  if (!e.clipboardData?.getData('text/plain')) e.preventDefault()
  emit('attach', files)
}

function hasFiles(e: DragEvent) {
  return props.attachable && Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  if (props.disabled) return
  dragDepth++
  dragging.value = true
}

function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault() // also stops the browser navigating to the dropped file
  if (e.dataTransfer) e.dataTransfer.dropEffect = props.disabled ? 'none' : 'copy'
}

function onDragLeave(e: DragEvent) {
  if (!hasFiles(e)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragging.value = false
}

function onDrop(e: DragEvent) {
  if (!hasFiles(e)) return
  e.preventDefault()
  dragDepth = 0
  dragging.value = false
  if (props.disabled) return
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length) emit('attach', files)
}

// ── model picker ───────────────────────────────────────────────────────────
// IuMenu is used rather than IuSelect: IuSelect's trigger is a full-width 40px
// form control, too heavy for a 28px footer. IuMenu's trigger is ours.
// A model option carrying a cost or effort levels switches the menu to the compact picker: names only, a cost glyph
// on each row, and the effort control under the chosen model. Without them the menu is the plain list it always was.
const compact = computed(() => !!props.models?.some(m => m.cost || m.effortLevels?.length))
const modelItems = computed(() => modelMenu(props.models ?? [], model.value, compact.value))
const optionOf = (id: string) => props.models?.find(m => m.id === id)

const currentModel = computed(
  () => props.models?.find(m => m.id === model.value) ?? props.models?.[0],
)

function pickModel(id: string) {
  model.value = id
}

const levels = computed(() => currentModel.value?.effortLevels ?? [])
const effortIndex = computed(() => levels.value.findIndex(l => l.id === effort.value))
const effortWord = computed(() =>
  effortIndex.value >= 0 ? levels.value[effortIndex.value]!.label : undefined,
)
const effortToneNow = computed(() => effortTone(effortIndex.value, levels.value.length))
/** ← → on the chosen model's row (menu focus) steps its effort, as the segments do under their own focus */
function onModelKeydown(e: KeyboardEvent) {
  if (!levels.value.length || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
  const panel = e.target instanceof HTMLElement ? e.target : null
  if (panel?.getAttribute('role') !== 'menu') return
  const chosen = currentModel.value?.id ?? ''
  if (!panel.getAttribute('aria-activedescendant')?.endsWith('-' + chosen)) return
  e.preventDefault()
  const next = effortIndex.value + (e.key === 'ArrowRight' ? 1 : -1)
  if (next < 0) effort.value = null
  else if (next < levels.value.length) effort.value = levels.value[next]!.id
}

// ── context ────────────────────────────────────────────────────────────────
function formatTokens(n: number) {
  return n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n)
}

const contextTitle = computed(() =>
  props.context
    ? `Context: ${formatTokens(props.context.used)} / ${formatTokens(props.context.max)} tokens`
    : undefined,
)

// ── lifecycle ──────────────────────────────────────────────────────────────
// reading the caret here also covers text set programmatically, where no key
// or input event has moved it yet
watch(
  text,
  () => {
    slashDismissed.value = false
    updateCaret()
    autosize()
  },
  { flush: 'post' },
)

onMounted(() => {
  updateCaret()
  autosize()
  window.addEventListener('resize', autosize)
  if (props.autofocus) textarea.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', autosize)
})
</script>

<template>
  <div
    class="iu-composer"
    :class="{
      'iu-composer--disabled': disabled,
      'iu-composer--busy': busy,
      'iu-composer--embedded': embedded,
    }"
  >
    <div
      v-if="menu"
      :id="`${uid}-cmds`"
      ref="cmdList"
      class="iu-composer__commands"
      role="listbox"
      :aria-label="menu.label"
    >
      <div
        v-for="(sec, si) in sections"
        :key="`${menu.kind}-${si}`"
        :role="sec.group ? 'group' : undefined"
        :aria-label="sec.group"
      >
        <div v-if="sec.group" class="iu-composer__group" aria-hidden="true">{{ sec.group }}</div>
        <div
          v-for="{ item, index } in sec.rows"
          :id="`${uid}-opt-${item.id}`"
          :key="item.id"
          class="iu-composer__command"
          role="option"
          :aria-selected="index === activeIndex"
          :data-active="index === activeIndex"
          @mousedown.prevent="item.pick()"
          @mouseenter="activeIndex = index"
        >
          <IuIcon :name="item.icon" :size="14" class="iu-composer__command-icon" />
          <span class="iu-composer__command-name">{{ item.label }}</span>
          <span v-if="item.argument" class="iu-composer__command-arg">{{ item.argument }}</span>
          <span v-if="item.description" class="iu-composer__command-desc">{{
            item.description
          }}</span>
        </div>
      </div>
    </div>

    <div
      class="iu-composer__frame"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <div v-if="attachments.length" class="iu-composer__attachments">
        <IuAttachment
          v-for="a in attachments"
          :key="a.id"
          :file="a"
          removable
          @remove="removeAttachment(a.id)"
          @retry="emit('retry', a)"
        />
      </div>

      <textarea
        ref="textarea"
        v-model="text"
        :rows="minRows"
        class="iu-composer__input"
        :aria-label="label"
        :placeholder="placeholder"
        :disabled="disabled"
        :role="hasMenus ? 'combobox' : undefined"
        :aria-expanded="hasMenus ? menuOpen : undefined"
        :aria-controls="hasMenus && menuOpen ? `${uid}-cmds` : undefined"
        :aria-autocomplete="hasMenus ? 'list' : undefined"
        :aria-activedescendant="activeCmdId"
        @keydown="onKeydown"
        @keyup="updateCaret"
        @click="updateCaret"
        @focus="updateCaret"
        @input="updateCaret"
        @paste="onPaste"
      />

      <p v-if="shownArgHint" class="iu-composer__arg-hint" aria-live="polite">
        {{ shownArgHint.prefix
        }}<span class="iu-composer__arg-hint-next">{{ shownArgHint.hint }}</span>
      </p>

      <div class="iu-composer__footer">
        <IuMenu
          v-if="addItems.length"
          :items="addItems"
          placement="top-start"
          fixed
          @select="pickAdd"
        >
          <template #trigger="{ toggle, open }">
            <IuButton
              variant="ghost"
              size="sm"
              icon-only
              aria-label="Add"
              aria-haspopup="menu"
              :aria-expanded="open"
              :disabled="disabled"
              @click="toggle"
            >
              <template #icon><IuIcon name="plus" :size="14" /></template>
            </IuButton>
          </template>
        </IuMenu>

        <div v-if="models?.length" class="iu-composer__model" @keydown="onModelKeydown">
          <IuMenu :items="modelItems" placement="top-start" fixed @select="pickModel">
            <template #trigger="{ toggle, open }">
              <IuButton
                variant="ghost"
                size="sm"
                aria-haspopup="menu"
                :aria-expanded="open"
                :disabled="disabled"
                @click="toggle"
              >
                {{ currentModel?.label ?? 'Model'
                }}<span
                  v-if="effortWord"
                  class="iu-composer__effort"
                  :data-effort-tone="effortToneNow"
                  >{{ effortWord }}</span
                >
                <template #trailing><IuIcon name="chevronDown" :size="14" /></template>
              </IuButton>
            </template>
            <template v-if="compact" #item="{ item }">
              <span class="iu-composer__model-row">
                <span class="iu-composer__model-name">{{ item.label }}</span>
                <span
                  v-if="'id' in item && optionOf(item.id)?.cost"
                  class="iu-composer__cost"
                  role="img"
                  :aria-label="`Cost ${optionOf(item.id)!.cost} of 4`"
                >
                  <span
                    v-for="n in 4"
                    :key="n"
                    class="iu-composer__cost-dot"
                    :class="{ 'iu-composer__cost-dot--on': n <= optionOf(item.id)!.cost! }"
                  />
                </span>
              </span>
            </template>
            <template v-if="compact" #after="{ item }">
              <EffortSegments
                v-if="
                  'id' in item &&
                  item.id === (currentModel?.id ?? '') &&
                  optionOf(item.id)?.effortLevels?.length
                "
                v-model="effort"
                :levels="optionOf(item.id)!.effortLevels!"
                :disabled="disabled"
              />
            </template>
          </IuMenu>
        </div>

        <slot name="controls" />

        <span class="iu-composer__spacer" />

        <div v-if="context" class="iu-composer__context" :title="contextTitle">
          <IuMeter
            :value="context.used"
            :max="context.max"
            layout="inline"
            size="sm"
            intent="auto"
            aria-label="Context window usage"
          />
        </div>

        <IuButton
          v-if="!showStop"
          variant="primary"
          size="sm"
          icon-only
          aria-label="Send"
          :disabled="!canSend"
          @click="submit()"
        >
          <template #icon><IuIcon name="arrowUp" :size="14" /></template>
        </IuButton>
        <IuButton
          v-else
          variant="secondary"
          size="sm"
          icon-only
          :aria-label="stopLabel"
          :title="stopLabel"
          :loading="stopping"
          @click="emit('stop')"
        >
          <template #icon><IuIcon name="stop" :size="14" /></template>
        </IuButton>

        <input ref="fileInput" type="file" multiple hidden tabindex="-1" @change="onPicked" />
      </div>

      <div v-if="dragging" class="iu-composer__drop" aria-hidden="true">Drop to attach</div>
    </div>

    <div class="iu-composer__hint" :class="{ 'iu-composer__hint--split': $slots['hint-start'] }">
      <span v-if="$slots['hint-start']" class="iu-composer__hint-start"
        ><slot name="hint-start"
      /></span>
      <span class="iu-composer__hint-end"
        ><slot name="hint"
          >↵ send · ⇧↵ newline · / commands{{ searchFiles ? ' · @ files' : '' }}</slot
        ></span
      >
    </div>
  </div>
</template>

<style>
.iu-composer {
  position: relative;
}

.iu-composer__frame {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 8px;
  background: var(--iu-surface);
  border: 1px solid var(--iu-hairline);
  border-top-color: var(--iu-lip-edge);
  border-radius: var(--iu-radius-lg);
  box-shadow: var(--iu-lip);
  transition: border-color var(--iu-dur) var(--iu-ease);
}
.iu-composer__frame:focus-within {
  border-color: var(--iu-border);
  border-top-color: var(--iu-lip-edge);
}
.iu-composer--disabled .iu-composer__frame {
  background: var(--iu-surface-sunken);
  border-color: var(--iu-hairline);
  box-shadow: none;
}

.iu-composer__attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.iu-composer__input {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  resize: none;
  overflow-y: hidden;
  color: var(--iu-text);
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-14);
  line-height: var(--iu-leading-normal);
}
.iu-composer__input::placeholder {
  color: var(--iu-text-muted);
}
.iu-composer__input:disabled {
  color: var(--iu-text-disabled);
  cursor: not-allowed;
}

.iu-composer__footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 28px;
}
.iu-composer__spacer {
  flex: 1;
}

.iu-composer__model {
  min-width: 0;
}

/* the effort word beside the model name takes its level's colour */
.iu-composer__effort {
  margin-left: 6px;
  color: var(--iu-effort-color);
}

/* compact model picker rows: the name, then the cost glyph at the right edge */
.iu-composer__model-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.iu-composer__model-name {
  flex: 1;
  min-width: 0;
}
.iu-composer__cost {
  display: inline-flex;
  gap: 3px;
  flex-shrink: 0;
}
.iu-composer__cost-dot {
  width: 4px;
  height: 4px;
  border-radius: var(--iu-radius-pill);
  background: var(--iu-border-strong);
}
.iu-composer__cost-dot--on {
  background: var(--iu-text-muted);
}

/* grid, not flex: a grid item stretches to the slot, so the meter's track gets
   the width (as a flex item it shrank to its text and the bar vanished) */
.iu-composer__context {
  display: grid;
  align-items: center;
  width: 84px;
  margin-right: 4px;
}

.iu-composer__hint {
  padding: 6px 2px 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}
/* hint-start on the left, the key hints on the right */
.iu-composer__hint--split {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
}
.iu-composer__hint--split .iu-composer__hint-end {
  margin-left: auto;
}

.iu-composer__drop {
  position: absolute;
  inset: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--iu-accent);
  border-radius: var(--iu-radius-lg);
  background: var(--iu-accent-wash);
  color: var(--iu-accent);
  font-size: var(--iu-font-size-12-5);
  pointer-events: none;
}

/* slash-command menu: floats above the frame, six rows then scrolls */
.iu-composer__commands {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 6px);
  z-index: 30;
  box-sizing: border-box;
  max-height: 202px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--iu-border-strong) transparent;
  padding: 5px;
  background: var(--iu-surface);
  border: 1px solid var(--iu-border-strong);
  border-radius: var(--iu-radius-lg);
  box-shadow: 0 14px 34px color-mix(in srgb, var(--iu-well) 70%, transparent);
}

.iu-composer__command {
  display: flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  height: 32px;
  min-width: 0;
  padding: 0 10px;
  border-radius: var(--iu-radius-md);
  color: var(--iu-text);
  cursor: pointer;
}
.iu-composer__command[data-active='true'] {
  background: var(--iu-raised);
}

.iu-composer__command-icon {
  flex-shrink: 0;
  color: var(--iu-text-muted);
}

.iu-composer__command-name {
  flex-shrink: 0;
  max-width: 50%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12-5);
}

.iu-composer__command-arg {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
}

.iu-composer__group {
  padding: 6px 10px 2px;
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
}

/* what to type next after an argument choice, e.g. "/review branch <branch>" */
.iu-composer__arg-hint {
  margin: 0;
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
.iu-composer__arg-hint-next {
  color: var(--iu-text-2);
}

.iu-composer__command-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-muted);
}
</style>
