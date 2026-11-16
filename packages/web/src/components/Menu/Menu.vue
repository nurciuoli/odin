<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  nextTick,
  onMounted,
  onBeforeUnmount,
  inject,
  provide,
  useId,
  type ComputedRef,
  type InjectionKey,
} from 'vue'
import { IuIcon, type IconName } from '@/components/Icon'

export type MenuItem =
  | {
      type?: 'item' | 'check' | 'radio'
      id: string
      label: string
      shortcut?: string
      icon?: IconName
      description?: string
      disabled?: boolean
      destructive?: boolean
      items?: MenuItem[]
      checked?: boolean
      group?: string
    }
  | { type: 'separator' }
  | { type: 'label'; label: string }

type ActionableItem = Extract<MenuItem, { id: string }>
type SubItem = ActionableItem & { items: MenuItem[] }

const props = withDefaults(
  defineProps<{
    items: MenuItem[]
    placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end'
    closeOnSelect?: boolean
    /**
     * Position the panel against the viewport (position: fixed) instead of the trigger, so a scrolling or clipping
     * ancestor (a table's scroll box) can't cut it off. It opens upward when there's no room below, and closes when
     * anything scrolls or the window resizes.
     */
    fixed?: boolean
    /** Open on right click or the context-menu key instead of a visible action button. */
    contextMenu?: boolean
    // set by Menu for the items of a parent item; not for consumers
    submenu?: boolean
  }>(),
  { placement: 'bottom-end', closeOnSelect: true, fixed: false, submenu: false },
)

const emit = defineEmits<{ select: [id: string] }>()

defineSlots<{
  trigger?(props: { open: boolean; toggle: () => void }): unknown
  /** replaces an item's label and description */
  item?(props: { item: ActionableItem }): unknown
  /** after an item's button, inside its entry (the compact model picker puts the effort control here) */
  after?(props: { item: ActionableItem }): unknown
}>()

// v-model:open is optional — the menu manages itself, but a parent can drive or observe it
const open = defineModel<boolean>('open', { default: false })

// what a panel shares with the submenus it opens. Selection and closing always
// go to the root, so a leaf anywhere in the tree behaves like a root leaf.
interface MenuScope {
  select: (id: string) => void
  closeAll: () => void
  closeSub: () => void
  subPanelId: ComputedRef<string | undefined>
}
// registry symbol: <script setup> re-runs per instance, so a plain Symbol() would differ between root and submenu
const MENU_SCOPE: InjectionKey<MenuScope> = Symbol.for('iu-menu-scope')
const up = inject(MENU_SCOPE, null)
const isSub = computed(() => props.submenu && up !== null)
// the parent's scope, only for a submenu: a plain menu nested in another menu's slot stays a root
function parentScope(): MenuScope | null {
  return isSub.value ? up : null
}
const visible = computed(() => isSub.value || open.value)

const activeId = ref<string | null>(null)
// the parent item whose submenu is open, and whether a hover (not a click or key) opened it
const openSubId = ref<string | null>(null)
const subFromHover = ref(false)
// item ids are prefixed per instance so two menus on a page never collide
const uid = useId()
const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const contextPoint = ref<{ x: number; y: number } | null>(null)
function onContextMenu(e: MouseEvent) {
  if (!props.contextMenu || panel.value?.contains(e.target as Node)) return
  e.preventDefault()
  contextPoint.value = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : null
  open.value = true
  if (panel.value) placeFixed()
}
function onContextKey(e: KeyboardEvent) {
  if (!props.contextMenu || panel.value?.contains(e.target as Node)) return
  if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
  e.preventDefault()
  contextPoint.value = null
  open.value = true
}
const subPanelId = computed(() => (openSubId.value ? `${uid}-sub-${openSubId.value}` : undefined))
// open submenus by parent id, so a keyboard open can hand focus to the one already showing
const subs = new Map<string, { enter: () => void }>()

// outside pointerdown closes; capture phase so it runs before anything that stops propagation
function onDocPointerDown(e: PointerEvent) {
  if (root.value && !root.value.contains(e.target as Node)) close()
}

watch(open, async isOpen => {
  if (isOpen) {
    document.addEventListener('pointerdown', onDocPointerDown, true)
    openSubId.value = null
    // land on the checked item (radio/check menus) or the first one, and take focus so keys work
    activeId.value = firstActive()
    await nextTick()
    if ((props.fixed || props.contextMenu) && !isSub.value) {
      // The native top layer escapes overflow/transform ancestors without changing DOM ancestry.
      panel.value?.showPopover?.()
      placeFixed()
      window.addEventListener('scroll', onViewportChange, true)
      window.addEventListener('resize', onViewportChange)
    }
    panel.value?.focus({ preventScroll: true })
    revealActive()
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    removeViewportListeners()
    openSubId.value = null
  }
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocPointerDown, true)
  removeViewportListeners()
})

// ── fixed placement ──
function onViewportChange(e: Event) {
  // scrolling inside the panel itself is fine
  if (
    e.type === 'scroll' &&
    panel.value &&
    e.target instanceof Node &&
    panel.value.contains(e.target)
  ) {
    if (e.target === panel.value) openSubId.value = null
    return
  }
  close()
}
function removeViewportListeners() {
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
}
function placeFixed() {
  const el = panel.value
  const anchor = root.value
  if (!el || !anchor) return
  const a = anchor.getBoundingClientRect()
  const h = el.scrollHeight
  if (contextPoint.value) {
    Object.assign(el.style, {
      position: 'fixed',
      margin: '0',
      bottom: 'auto',
      right: 'auto',
      left: `${Math.max(EDGE, Math.min(contextPoint.value.x, window.innerWidth - el.offsetWidth - EDGE))}px`,
      top: `${Math.max(EDGE, Math.min(contextPoint.value.y, window.innerHeight - h - EDGE))}px`,
      maxHeight: `${Math.max(0, window.innerHeight - 2 * EDGE)}px`,
      overflowY: 'auto',
    })
    return
  }
  const gap = 4
  const wantsTop = props.placement.startsWith('top')
  const roomBelow = window.innerHeight - a.bottom - gap - EDGE
  const roomAbove = a.top - gap - EDGE
  const up = wantsTop
    ? roomAbove >= h || roomAbove > roomBelow
    : roomBelow < h && roomAbove > roomBelow
  const available = Math.max(0, up ? roomAbove : roomBelow)
  Object.assign(el.style, {
    position: 'fixed',
    margin: '0',
    top: up ? 'auto' : `${a.bottom + gap}px`,
    bottom: up ? `${window.innerHeight - a.top + gap}px` : 'auto',
    maxHeight: `${available}px`,
    overflowY: 'auto',
    left: `${Math.max(EDGE, Math.min(props.placement.endsWith('start') ? a.left : a.right - el.offsetWidth, window.innerWidth - el.offsetWidth - EDGE))}px`,
    right: 'auto',
  })
}

function revealActive() {
  const el = panel.value
  const item = el?.querySelector<HTMLElement>('[data-active="true"]')
  if (!el || !item) return
  const a = item.getBoundingClientRect(),
    p = el.getBoundingClientRect()
  if (a.top < p.top) el.scrollTop -= p.top - a.top
  else if (a.bottom > p.bottom) el.scrollTop += a.bottom - p.bottom
}
watch(activeId, () => nextTick(revealActive))

function closeAndReturnFocus() {
  close()
  // back to the trigger, the first focusable thing in the slot
  root.value
    ?.querySelector<HTMLElement>('a[href], button, [tabindex]:not([tabindex="-1"])')
    ?.focus()
}

function isActionable(item: MenuItem): item is ActionableItem {
  return item.type !== 'separator' && item.type !== 'label'
}

function hasSub(item: MenuItem): item is SubItem {
  return isActionable(item) && !!item.items?.length
}

const focusable = computed(() => props.items.filter(isActionable))

function firstActive(): string | null {
  return focusable.value.find(i => i.checked)?.id ?? focusable.value[0]?.id ?? null
}

// typeahead: collected keystrokes jump to the first matching label
let buffer = ''
let bufferTimer: ReturnType<typeof setTimeout> | undefined

function close() {
  open.value = false
}

function closeAll() {
  const parent = parentScope()
  if (parent) parent.closeAll()
  else close()
}

// Escape and ArrowLeft in a submenu: close it, put focus back on the parent item
function closeSub() {
  const id = openSubId.value
  if (id === null) return
  openSubId.value = null
  activeId.value = id
  nextTick(() => panel.value?.focus({ preventScroll: true }))
}

function leave() {
  parentScope()?.closeSub()
}

provide(MENU_SCOPE, { select: choose, closeAll, closeSub, subPanelId })

function choose(id: string) {
  const parent = parentScope()
  if (parent) return parent.select(id)
  emit('select', id)
  if (props.closeOnSelect) closeAndReturnFocus()
}

function setActive(id: string) {
  activeId.value = id
  if (openSubId.value !== null && openSubId.value !== id) openSubId.value = null
}

function move(direction: number) {
  const list = focusable.value
  if (!list.length) return
  const idx = list.findIndex(i => i.id === activeId.value)
  setActive(list[(idx + direction + list.length) % list.length]!.id)
}

function openSub(id: string, how: 'key' | 'hover' | 'click') {
  activeId.value = id
  subFromHover.value = how === 'hover'
  openSubId.value = id
  // the submenu mounts on this tick; focus it once it exists
  if (how === 'key') nextTick(() => subs.get(id)?.enter())
}

function activate(item: ActionableItem | undefined) {
  if (!item || item.disabled) return
  if (hasSub(item)) return openSub(item.id, 'key')
  choose(item.id)
}

function onKeydown(e: KeyboardEvent) {
  // a submenu's keys are its own; the panel it sits in must not act on them too
  if (isSub.value) e.stopPropagation()
  const item = focusable.value.find(i => i.id === activeId.value)
  switch (e.key) {
    case 'Escape':
      e.preventDefault()
      e.stopPropagation()
      return isSub.value ? leave() : closeAndReturnFocus()
    case 'Tab':
      e.stopPropagation()
      return closeAll()
    case 'ArrowLeft':
      if (!isSub.value) return
      e.preventDefault()
      return leave()
    case 'ArrowRight':
      if (!item || item.disabled || !hasSub(item)) return
      e.preventDefault()
      return openSub(item.id, 'key')
    case 'ArrowDown':
      e.preventDefault()
      return move(1)
    case 'ArrowUp':
      e.preventDefault()
      return move(-1)
    case 'Home':
    case 'End': {
      e.preventDefault()
      const list = focusable.value
      const edge = e.key === 'Home' ? list[0] : list[list.length - 1]
      if (edge) setActive(edge.id)
      return
    }
    case 'Enter':
    case ' ':
      e.preventDefault()
      return activate(item)
  }
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    buffer += e.key.toLowerCase()
    clearTimeout(bufferTimer)
    bufferTimer = setTimeout(() => (buffer = ''), 600)
    const hit = focusable.value.find(i => i.label.toLowerCase().startsWith(buffer))
    if (hit) setActive(hit.id)
  }
}

function onHover(it: ActionableItem) {
  if (it.disabled) return
  if (hasSub(it)) {
    if (openSubId.value !== it.id) openSub(it.id, 'hover')
  } else {
    setActive(it.id)
  }
}

function onItemClick(it: ActionableItem) {
  if (!hasSub(it)) return choose(it.id)
  // a click on an item its hover already opened keeps it open; the next click closes it
  if (openSubId.value === it.id && !subFromHover.value) {
    openSubId.value = null
    activeId.value = it.id
  } else {
    openSub(it.id, 'click')
  }
}

function setSub(id: string, el: unknown) {
  if (el) subs.set(id, el as { enter: () => void })
  else subs.delete(id)
}

// the submenu takes focus only when the keyboard opened it; hovering never moves focus
function enter() {
  activeId.value = firstActive()
  panel.value?.focus({ preventScroll: true })
  nextTick(revealActive)
}
defineExpose({ enter })

// a submenu opens beside its parent item and is nudged in from the viewport edges
const EDGE = 8
function placeSub() {
  const el = panel.value
  const anchor = root.value?.closest<HTMLElement>('.iu-menu__entry')
  if (!el || !anchor) return
  el.showPopover?.()
  const a = anchor.getBoundingClientRect()
  const width = el.offsetWidth
  const height = el.offsetHeight
  const left = a.right - 2 + width <= window.innerWidth - EDGE ? a.right - 2 : a.left - width + 2
  Object.assign(el.style, {
    position: 'fixed',
    margin: '0',
    bottom: 'auto',
    right: 'auto',
    left: `${Math.max(EDGE, Math.min(left, window.innerWidth - width - EDGE))}px`,
    top: `${Math.max(EDGE, Math.min(a.top, window.innerHeight - height - EDGE))}px`,
    overflowY: 'auto',
  })
}

onMounted(() => {
  if (isSub.value) placeSub()
})
</script>

<template>
  <div
    ref="root"
    class="iu-menu"
    :class="{ 'iu-menu--sub': isSub }"
    @contextmenu="onContextMenu"
    @keydown="onContextKey"
  >
    <slot v-if="!isSub" name="trigger" :open="open" :toggle="() => (open = !open)" />
    <div
      v-if="visible"
      ref="panel"
      class="iu-menu__panel"
      :class="isSub ? 'iu-menu__panel--sub' : `iu-menu__panel--${placement}`"
      :id="isSub ? up?.subPanelId.value : undefined"
      role="menu"
      :popover="fixed || contextMenu || isSub ? 'manual' : undefined"
      tabindex="-1"
      :aria-activedescendant="activeId !== null ? `${uid}-${activeId}` : undefined"
      @keydown="onKeydown"
    >
      <template
        v-for="(it, i) in items"
        :key="it.type === 'separator' || it.type === 'label' ? i : it.id"
      >
        <hr v-if="it.type === 'separator'" class="iu-menu__sep" />
        <div v-else-if="it.type === 'label'" class="iu-menu__label">{{ it.label }}</div>
        <div v-else class="iu-menu__entry" role="none">
          <button
            :id="`${uid}-${it.id}`"
            class="iu-menu__item"
            :role="
              it.type === 'radio'
                ? 'menuitemradio'
                : it.type === 'check'
                  ? 'menuitemcheckbox'
                  : 'menuitem'
            "
            :aria-checked="it.type === 'radio' || it.type === 'check' ? !!it.checked : undefined"
            tabindex="-1"
            :aria-haspopup="hasSub(it) ? 'menu' : undefined"
            :aria-expanded="hasSub(it) ? openSubId === it.id : undefined"
            :aria-controls="openSubId === it.id ? subPanelId : undefined"
            :data-active="it.id === activeId"
            :data-destructive="it.destructive"
            :disabled="it.disabled"
            @click="onItemClick(it)"
            @pointermove="onHover(it)"
          >
            <span v-if="it.type === 'check'" class="iu-menu__check" aria-hidden="true">
              {{ it.checked ? '✓' : '' }}
            </span>
            <span v-else-if="it.type === 'radio'" class="iu-menu__radio" aria-hidden="true">
              {{ it.checked ? '●' : '' }}
            </span>
            <IuIcon v-else-if="it.icon" :name="it.icon" :size="16" class="iu-menu__icon" />
            <span class="iu-menu__content">
              <slot name="item" :item="it">
                <span class="iu-menu__label-text">{{ it.label }}</span>
                <span v-if="it.description" class="iu-menu__description">{{ it.description }}</span>
              </slot>
            </span>
            <span v-if="it.shortcut" class="iu-menu__shortcut">{{ it.shortcut }}</span>
            <span v-if="hasSub(it)" class="iu-menu__submenu-indicator" aria-hidden="true">▸</span>
          </button>
          <slot name="after" :item="it" />
          <Menu
            v-if="hasSub(it) && openSubId === it.id"
            :ref="el => setSub(it.id, el)"
            :items="it.items"
            submenu
          >
            <template v-if="$slots.item" #item="{ item }"
              ><slot name="item" :item="item"
            /></template>
            <template v-if="$slots.after" #after="{ item }"
              ><slot name="after" :item="item"
            /></template>
          </Menu>
        </div>
      </template>
    </div>
  </div>
</template>

<style>
.iu-menu {
  position: relative;
  display: inline-block;
}

/* a submenu is laid out against its parent item's entry, not the trigger */
.iu-menu--sub {
  position: static;
  display: block;
}

.iu-menu__entry {
  position: relative;
}

.iu-menu__panel {
  position: absolute;
  background: var(--iu-raised);
  border: 1px solid var(--iu-border-strong);
  border-radius: var(--iu-radius-lg);
  box-shadow: 0 14px 34px color-mix(in srgb, var(--iu-well) 80%, transparent);
  padding: 5px;
  box-sizing: border-box;
  width: max-content;
  min-width: min(220px, calc(100vw - 16px));
  max-width: min(320px, calc(100vw - 16px));
  max-height: calc(100dvh - 16px);
  z-index: 1000;
}

/* Placement variants */
.iu-menu__panel--bottom-start {
  top: 100%;
  left: 0;
  margin-top: 4px;
}

.iu-menu__panel--bottom-end {
  top: 100%;
  right: 0;
  margin-top: 4px;
}

.iu-menu__panel--top-start {
  bottom: 100%;
  left: 0;
  margin-bottom: 4px;
}

.iu-menu__panel--top-end {
  bottom: 100%;
  right: 0;
  margin-bottom: 4px;
}

/* beside the parent item, top-aligned, overlapping its edge by 2px */
.iu-menu__panel--sub {
  top: 0;
  left: calc(100% - 2px);
}

/* Menu items */
.iu-menu__item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: var(--iu-radius-md);
  border: none;
  background: transparent;
  color: var(--iu-text);
  cursor: pointer;
  font-family: var(--iu-font-sans);
  font-size: var(--iu-font-size-14);
  width: 100%;
  text-align: left;
  transition: background-color 0.12s ease;
}

.iu-menu__item:hover:not(:disabled) {
  background: var(--iu-surface);
}

.iu-menu__item[data-active='true'] {
  background: var(--iu-surface);
}

.iu-menu__item[data-destructive='true'] {
  color: var(--iu-danger);
}

.iu-menu__item[data-destructive='true']:hover:not(:disabled) {
  background: var(--iu-danger-wash);
}

.iu-menu__item:disabled {
  color: var(--iu-text-disabled);
  cursor: not-allowed;
}

.iu-menu__icon {
  flex-shrink: 0;
  color: var(--iu-text-muted);
}

/* Check and radio indicators */
.iu-menu__check,
.iu-menu__radio {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 12px;
  font-size: var(--iu-font-size-12);
  color: var(--iu-accent);
  flex-shrink: 0;
}

/* Content area */
.iu-menu__content {
  min-width: 0;
  overflow-wrap: anywhere;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  text-align: left;
}

.iu-menu__label-text {
  line-height: var(--iu-leading-snug);
}

.iu-menu__description {
  font-size: var(--iu-font-size-12);
  color: var(--iu-text-2);
  line-height: var(--iu-leading-snug);
}

/* Shortcuts */
.iu-menu__shortcut {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  margin-left: auto;
  flex-shrink: 0;
  white-space: nowrap;
}

/* Submenu indicator */
.iu-menu__submenu-indicator {
  font-size: var(--iu-font-size-11);
  color: var(--iu-text-muted);
  margin-left: auto;
  flex-shrink: 0;
}

/* Separators */
.iu-menu__sep {
  height: 1px;
  background: var(--iu-border);
  border: none;
  margin: 5px 0;
  padding: 0;
}

/* Section labels */
.iu-menu__label {
  font-family: var(--iu-font-mono);
  font-size: var(--iu-font-size-10);
  letter-spacing: var(--iu-tracking-caps);
  text-transform: uppercase;
  color: var(--iu-text-muted);
  padding: 7px 10px 4px;
}
</style>
