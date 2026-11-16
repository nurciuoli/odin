import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchShortcut,
  isEditable,
  keyCaps,
  keyLabel,
  matchesKeys,
  nextWaiting,
  registerShortcut,
  stepSession,
  useShortcuts,
} from './shortcuts'

const key = (init: KeyboardEventInit, target?: EventTarget) => {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  if (target) Object.defineProperty(e, 'target', { value: target })
  return e
}

const offs: (() => void)[] = []
afterEach(() => {
  for (const off of offs.splice(0)) off()
  document.body.innerHTML = ''
})

describe('matchesKeys', () => {
  it('treats Mod as Ctrl or ⌘ and checks the other modifiers exactly', () => {
    expect(matchesKeys('Mod+K', key({ key: 'k', ctrlKey: true }))).toBe(true)
    expect(matchesKeys('Mod+K', key({ key: 'k', metaKey: true }))).toBe(true)
    expect(matchesKeys('Mod+K', key({ key: 'k' }))).toBe(false)
    expect(matchesKeys('Mod+K', key({ key: 'K', ctrlKey: true, shiftKey: true }))).toBe(false)
    expect(matchesKeys('Mod+Shift+O', key({ key: 'O', ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('matches the physical key when ⌥ changes the character, and ? whatever Shift says', () => {
    expect(matchesKeys('Alt+/', key({ key: '÷', code: 'Slash', altKey: true }))).toBe(true)
    expect(matchesKeys('?', key({ key: '?', shiftKey: true }))).toBe(true)
    expect(matchesKeys('Alt+ArrowUp', key({ key: 'ArrowUp', altKey: true }))).toBe(true)
    expect(matchesKeys('Mod+1-9', key({ key: '3', code: 'Digit3', metaKey: true }))).toBe(true)
    expect(matchesKeys('Mod+1-9', key({ key: '0', code: 'Digit0', metaKey: true }))).toBe(false)
  })
})

describe('labels', () => {
  it('reads as ⌘⇧O on macOS and Ctrl+Shift+O elsewhere', () => {
    expect(keyLabel('Mod+Shift+O', true)).toBe('⌘⇧O')
    expect(keyLabel('Mod+Shift+O', false)).toBe('Ctrl+Shift+O')
    expect(keyCaps('Alt+ArrowDown', true)).toEqual(['⌥', '↓'])
    expect(keyCaps('Mod+1-9', false)).toEqual(['Ctrl', '1…9'])
  })
})

describe('dispatchShortcut', () => {
  it('runs the newest registration, and lists every shortcut once per id', () => {
    const first = vi.fn()
    const second = vi.fn()
    offs.push(registerShortcut({ id: 'a', keys: '?', label: 'A', group: 'General', run: first }))
    offs.push(registerShortcut({ id: 'b', keys: '?', label: 'B', group: 'General', run: second }))
    const e = key({ key: '?', shiftKey: true })
    expect(dispatchShortcut(e)).toBe(true)
    expect(e.defaultPrevented).toBe(true)
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([0, 1])
    offs.push(
      registerShortcut({ id: 'a', keys: '?', label: 'A again', group: 'General', run: first }),
    )
    expect(
      useShortcuts()
        .value.filter(s => s.id === 'a')
        .map(s => s.label),
    ).toEqual(['A again'])
  })

  it('waits while typing unless whileTyping, and while a dialog is open unless inDialog', () => {
    const plain = vi.fn()
    const typing = vi.fn()
    offs.push(registerShortcut({ id: 'p', keys: '?', label: 'P', group: 'G', run: plain }))
    offs.push(
      registerShortcut({
        id: 't',
        keys: 'Mod+J',
        label: 'T',
        group: 'G',
        whileTyping: true,
        run: typing,
      }),
    )
    const input = document.createElement('textarea')
    document.body.append(input)
    expect(dispatchShortcut(key({ key: '?', shiftKey: true }, input))).toBe(false)
    expect(dispatchShortcut(key({ key: 'j', ctrlKey: true }, input))).toBe(true)
    expect(typing).toHaveBeenCalledTimes(1)

    const dialog = document.createElement('dialog')
    dialog.setAttribute('open', '')
    document.body.append(dialog)
    expect(dispatchShortcut(key({ key: 'j', ctrlKey: true }))).toBe(false)
    expect(plain).not.toHaveBeenCalled()
  })

  it('stops after unregistering', () => {
    const run = vi.fn()
    const off = registerShortcut({ id: 'x', keys: 'Mod+K', label: 'X', group: 'G', run })
    off()
    expect(dispatchShortcut(key({ key: 'k', ctrlKey: true }))).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('isEditable', () => {
  it('counts text fields and editors, not buttons or checkboxes', () => {
    const text = document.createElement('input')
    const box = document.createElement('input')
    box.type = 'checkbox'
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    expect([
      isEditable(text),
      isEditable(box),
      isEditable(document.createElement('button')),
    ]).toEqual([true, false, false])
    expect(isEditable(editor)).toBe(true)
  })
})

describe('session navigation', () => {
  const ids = ['a', 'b', 'c']
  it('steps through the sidebar without wrapping, starting from an end off a session', () => {
    expect(stepSession(ids, 'b', 1)).toBe('c')
    expect(stepSession(ids, 'c', 1)).toBeNull()
    expect(stepSession(ids, 'a', -1)).toBeNull()
    expect(stepSession(ids, null, 1)).toBe('a')
    expect(stepSession(ids, 'elsewhere', -1)).toBe('c')
    expect(stepSession([], null, 1)).toBeNull()
  })

  it('cycles the waiting sessions and has nowhere to go when only this one waits', () => {
    expect(nextWaiting(ids, null)).toBe('a')
    expect(nextWaiting(ids, 'c')).toBe('a')
    expect(nextWaiting(ids, 'a')).toBe('b')
    expect(nextWaiting(['a'], 'a')).toBeNull()
    expect(nextWaiting([], null)).toBeNull()
  })
})
