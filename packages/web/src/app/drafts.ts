// Composer drafts, app-wide, keyed by session id (`'new'` for the new-session composer). Switching sessions unmounts
// the composer, so the draft lives here instead: text and attachments in memory; the text alone is mirrored to
// localStorage (`odin:draft:<key>`) so a reload keeps it. Empty drafts are dropped; at most 50 drafts are kept,
// least recently written first out.
import type { Attachment } from '@odin/shared/api'
import type { Attachment as ChatAttachment } from '@/components/Chat'

export interface DraftAttachment {
  chip: ChatAttachment
  payload: Attachment
}
export interface Draft {
  text: string
  attachments: DraftAttachment[]
}

export interface Drafts {
  /** The draft for `key`, or an empty one. A copy: changing it changes nothing until `set`. */
  get(key: string): Draft
  set(key: string, draft: Draft): void
  clear(key: string): void
  /** Adds `text` as a new paragraph at the end of the draft's text. */
  append(key: string, text: string): void
  /** Called after any change to `key`'s draft (from anywhere). Returns the unsubscribe. */
  subscribe(key: string, listener: () => void): () => void
}

export const DRAFT_LIMIT = 50
const PREFIX = 'odin:draft:'
const INDEX = 'odin:draft-index'

const empty = (): Draft => ({ text: '', attachments: [] })
const isEmpty = (d: Draft) => !d.text.trim() && d.attachments.length === 0
const copy = (d: Draft): Draft => ({
  text: d.text,
  attachments: d.attachments.map(a => ({ ...a })),
})

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
function readIndex(): string[] {
  try {
    const raw = storage()?.getItem(INDEX)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : []
  } catch {
    return []
  }
}
function writeStored(key: string, text: string | null) {
  const s = storage()
  if (!s) return
  try {
    let index = readIndex().filter(k => k !== key)
    if (text === null || !text.trim()) s.removeItem(PREFIX + key)
    else {
      s.setItem(PREFIX + key, text)
      index.push(key)
      while (index.length > DRAFT_LIMIT) s.removeItem(PREFIX + index.shift()!)
    }
    index = index.slice(-DRAFT_LIMIT)
    s.setItem(INDEX, JSON.stringify(index))
  } catch {
    // storage full or blocked: the in-memory draft still holds
  }
}
function readStored(key: string): string {
  try {
    return storage()?.getItem(PREFIX + key) ?? ''
  } catch {
    return ''
  }
}

export function createDrafts(): Drafts {
  // insertion order is recency: a write moves the key to the end
  const memory = new Map<string, Draft>()
  const listeners = new Map<string, Set<() => void>>()
  const notify = (key: string) => {
    for (const l of [...(listeners.get(key) ?? [])]) l()
  }
  function get(key: string): Draft {
    const held = memory.get(key)
    if (held) return copy(held)
    return { text: readStored(key), attachments: [] }
  }
  function set(key: string, draft: Draft) {
    memory.delete(key)
    if (isEmpty(draft)) writeStored(key, null)
    else {
      memory.set(key, copy(draft))
      while (memory.size > DRAFT_LIMIT) memory.delete(memory.keys().next().value!)
      writeStored(key, draft.text)
    }
    notify(key)
  }
  function clear(key: string) {
    memory.delete(key)
    writeStored(key, null)
    notify(key)
  }
  function append(key: string, text: string) {
    if (!text.trim()) return
    const current = get(key)
    const base = current.text.replace(/\s+$/, '')
    set(key, { ...current, text: base ? `${base}\n\n${text}` : text })
  }
  function subscribe(key: string, listener: () => void) {
    let set = listeners.get(key)
    if (!set) listeners.set(key, (set = new Set()))
    set.add(listener)
    return () => {
      set.delete(listener)
      if (!set.size) listeners.delete(key)
    }
  }
  return { get, set, clear, append, subscribe }
}

let shared: Drafts | null = null
/** The app-wide drafts store. */
export function useDrafts(): Drafts {
  return (shared ??= createDrafts())
}
/** Tests: forget the in-memory drafts (localStorage is left to the test). */
export function resetDrafts() {
  shared = null
}

export { empty as emptyDraft }
