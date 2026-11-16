// The app's keyboard shortcuts, registered in one place. One keydown listener for the whole app (`installShortcuts`,
// mounted by the shell) dispatches to whatever is registered; the `?` cheat sheet lists the same entries, so a
// shortcut that exists is a shortcut that's documented. Desktop (Electron) can map the same accelerators later; this
// registry is the source of truth.
//
// Rules: a shortcut is skipped while focus is in an editable element (unless `whileTyping`) and while a dialog is
// open (unless `inDialog`). The newest registration of a key combination wins, so a screen can take over a key while
// it's mounted.
import { shallowRef, type ShallowRef } from 'vue'

export interface Shortcut {
  /** Stable id; registering the same id again replaces the earlier entry. */
  id: string
  /**
   * `+`-joined modifiers and a key: `Mod+K`, `Mod+Shift+O`, `Alt+ArrowUp`, `Alt+/`, `?`. `Mod` is ⌘ on macOS and
   * Ctrl elsewhere. `1-9` matches any digit key from 1 to 9 (`Mod+1-9`); `run` reads which from the event.
   */
  keys: string
  /** What it does, for the cheat sheet: "Open the command palette". */
  label: string
  /** Cheat sheet heading: "General", "Sessions", "Session". */
  group: string
  /** Also fires while typing in an input, textarea or editor. */
  whileTyping?: boolean
  /** Also fires while a dialog is open (the palette's own toggle). */
  inDialog?: boolean
  run: (event: KeyboardEvent) => void
}

const registry: ShallowRef<Shortcut[]> = shallowRef([])

/** Adds a shortcut; returns the function that removes it again. */
export function registerShortcut(shortcut: Shortcut): () => void {
  registry.value = [...registry.value.filter(s => s.id !== shortcut.id), shortcut]
  return () => {
    registry.value = registry.value.filter(s => s !== shortcut)
  }
}

/** Everything registered right now, oldest first (the cheat sheet reads it). */
export function useShortcuts(): Readonly<ShallowRef<Shortcut[]>> {
  return registry
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
}

interface Combo {
  mod: boolean
  shift: boolean
  alt: boolean
  key: string
}
function parse(keys: string): Combo {
  const parts = keys.split('+')
  const key = parts.pop() ?? ''
  return {
    mod: parts.includes('Mod'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
    key,
  }
}

// Punctuation that needs Shift on most layouts (`?`): Shift is part of the character, not a modifier to check.
const shifted = (key: string) => key.length === 1 && !/[a-z0-9/]/i.test(key)

function keyMatches(key: string, e: KeyboardEvent): boolean {
  if (key === '1-9') return /^[1-9]$/.test(e.key) || /^Digit[1-9]$/.test(e.code)
  // Match on the physical key too: ⌥ on macOS turns `/` into `÷` and `o` into `ø`.
  if (/^[a-z]$/i.test(key))
    return e.key.toLowerCase() === key.toLowerCase() || e.code === `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return e.key === key || e.code === `Digit${key}`
  if (key === '/') return e.key === '/' || e.code === 'Slash'
  return e.key === key
}

/** Whether a keydown is this combination. Exported for tests. */
export function matchesKeys(keys: string, e: KeyboardEvent): boolean {
  const c = parse(keys)
  if (!keyMatches(c.key, e)) return false
  if (c.mod !== (e.metaKey || e.ctrlKey)) return false
  if (c.alt !== e.altKey) return false
  if (!shifted(c.key) && c.shift !== e.shiftKey) return false
  return true
}

const NAMES_MAC: Record<string, string> = { Mod: '⌘', Shift: '⇧', Alt: '⌥', Ctrl: '⌃' }
const NAMES_OTHER: Record<string, string> = {
  Mod: 'Ctrl',
  Shift: 'Shift',
  Alt: 'Alt',
  Ctrl: 'Ctrl',
}
const KEY_NAMES: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↵',
  Escape: 'Esc',
  '1-9': '1…9',
}

/** The keys as the user reads them, one label per key cap: `['⌘', '⇧', 'O']` on macOS, `['Ctrl', 'Shift', 'O']` elsewhere. */
export function keyCaps(keys: string, mac: boolean = isMac()): string[] {
  const parts = keys.split('+')
  const key = parts.pop() ?? ''
  const names = mac ? NAMES_MAC : NAMES_OTHER
  return [
    ...parts.map(p => names[p] ?? p),
    KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key),
  ]
}

/** One string for hints and titles: `⌘⇧O` on macOS, `Ctrl+Shift+O` elsewhere. */
export function keyLabel(keys: string, mac: boolean = isMac()): string {
  return keyCaps(keys, mac).join(mac ? '' : '+')
}

/** Inputs you type into, textareas, selects and contenteditable editors (CodeMirror). */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (target.getAttribute('type') ?? 'text').toLowerCase()
    return !NOT_TYPING.includes(type)
  }
  return (
    (target as HTMLElement).isContentEditable === true ||
    !!target.closest(
      '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    )
  )
}
const NOT_TYPING = ['button', 'checkbox', 'radio', 'range', 'reset', 'submit', 'color', 'file']

function dialogOpen(): boolean {
  return typeof document !== 'undefined' && !!document.querySelector('dialog[open]')
}

/** The one keydown listener. Exported for tests; the shell uses `installShortcuts`. */
export function dispatchShortcut(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.repeat) return false
  const list = registry.value
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i]!
    if (!matchesKeys(s.keys, e)) continue
    if (dialogOpen() && !s.inDialog) return false
    if (isEditable(e.target) && !s.whileTyping) return false
    e.preventDefault()
    s.run(e)
    return true
  }
  return false
}

/** Starts listening on `window`; returns the function that stops. */
export function installShortcuts(target: Window = window): () => void {
  const onKeydown = (e: KeyboardEvent) => void dispatchShortcut(e)
  target.addEventListener('keydown', onKeydown)
  return () => target.removeEventListener('keydown', onKeydown)
}

/** Where ⌥↑ / ⌥↓ go from `currentId` in `ids`: the neighbour, or the first/last row when you're not on one. */
export function stepSession(
  ids: readonly string[],
  currentId: string | null,
  dir: 1 | -1,
): string | null {
  if (!ids.length) return null
  const at = currentId ? ids.indexOf(currentId) : -1
  if (at === -1) return dir === 1 ? ids[0]! : ids[ids.length - 1]!
  const next = at + dir
  return next >= 0 && next < ids.length ? ids[next]! : null
}

/** ⌘J: the waiting session after the current one, cycling; null when nothing else waits. */
export function nextWaiting(ids: readonly string[], currentId: string | null): string | null {
  const others = ids.filter(id => id !== currentId)
  if (!others.length) return null
  const at = currentId ? ids.indexOf(currentId) : -1
  if (at === -1) return ids[0]!
  return ids[(at + 1) % ids.length]!
}
