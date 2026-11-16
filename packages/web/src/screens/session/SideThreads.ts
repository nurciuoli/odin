// Side threads: questions asked beside a session (`Session.aside`, a fork of the open session). The model behind the
// session screen's Side view: which sessions are this one's side threads (kept live from session events), where the
// side conversation starts inside the forked transcript, and the reply that "Insert into message" quotes.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import type { Session } from '@odin/shared/api'
import type { ServerEvent } from '@odin/shared/events'
import type { TranscriptEntry } from '@odin/shared/harness'
import { useApi } from '@/api'

/** `/btw <question>` typed as the whole message asks it on the side. The question, or null. */
export function parseSideCommand(text: string): string | null {
  const m = /^\/btw\s+([\s\S]*\S[\s\S]*)$/.exec(text.trim())
  return m ? m[1]!.trim() : null
}

/** Newest first. */
export function sortSideThreads(list: Session[]): Session[] {
  return [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1))
}

/** `list` with `session` applied: added or replaced when it is a side thread of `parentId`, else removed (promoted). */
export function upsertSideThread(list: Session[], session: Session, parentId: string): Session[] {
  const others = list.filter(s => s.id !== session.id)
  if (!session.aside || session.parentId !== parentId)
    return others.length === list.length ? list : others
  return sortSideThreads([...others, session])
}

// how far an entry's clock may sit before the fork's createdAt and still count as the side question
const CLOCK_SLACK_MS = 1000

/**
 * The side conversation inside a side thread's transcript. A fork carries the parent's conversation up to the fork;
 * the side part starts at the side question. When the copied entries keep their ids, everything up to the last entry
 * the parent also has is the parent's. Otherwise: the first top-level user message, written once the fork existed,
 * that the default title (`Side: <prompt…>`) quotes; failing that (a renamed thread), the first one written once the
 * fork existed. With nothing to go by, the whole transcript.
 */
export function sideEntries(
  transcript: TranscriptEntry[],
  session: { createdAt: string; title: string },
  parentIds: ReadonlySet<string> = new Set(),
): TranscriptEntry[] {
  let copied = 0
  while (copied < transcript.length && parentIds.has(transcript[copied]!.id)) copied++
  if (copied > 0) return transcript.slice(copied)
  const since = Date.parse(session.createdAt) - CLOCK_SLACK_MS
  if (Number.isNaN(since)) return transcript
  const after = (e: TranscriptEntry) =>
    e.kind === 'user' && e.parentToolUseId === null && e.at !== null && Date.parse(e.at) >= since
  const asked = /^Side: (.+?)(?:…|\.\.\.)?$/.exec(session.title.trim())?.[1]?.trim()
  let start = asked
    ? transcript.findIndex(e => after(e) && e.kind === 'user' && e.text.trim().startsWith(asked))
    : -1
  if (start < 0) start = transcript.findIndex(after)
  return start < 0 ? transcript : transcript.slice(start)
}

/** The last turn's reply: the top-level assistant text after the last user message, or null before one exists. */
export function lastReply(entries: TranscriptEntry[]): string | null {
  const parts: string[] = []
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.parentToolUseId !== null) continue
    if (e.kind === 'user') break
    if (e.kind === 'assistant' && e.text.trim()) parts.unshift(e.text.trim())
  }
  return parts.length ? parts.join('\n\n') : null
}

/** A markdown blockquote of `text`. */
export function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map(line => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}

export type SideThreadsPhase = 'loading' | 'ready' | 'error'

/** The open session's side threads, newest first, kept live from `session.updated` / `session.removed`. */
export function useSideThreads(parentId: Ref<string>) {
  const api = useApi()
  const threads = shallowRef<Session[]>([])
  const phase = ref<SideThreadsPhase>('loading')
  const error = ref<string | null>(null)
  let latest = 0

  async function reload() {
    const token = ++latest
    const parent = parentId.value
    if (phase.value !== 'ready') phase.value = 'loading'
    try {
      const list = await api.listSessions({ parentId: parent, aside: true })
      if (token !== latest) return
      // listing by parentId includes ordinary forks: keep the side threads
      threads.value = sortSideThreads(list.filter(s => s.aside && s.parentId === parent))
      phase.value = 'ready'
      error.value = null
    } catch (e) {
      if (token !== latest) return
      error.value = e instanceof Error ? e.message : String(e)
      if (phase.value !== 'ready') phase.value = 'error'
    }
  }

  /** A side thread this page just made or changed (fork, promote). */
  function apply(session: Session) {
    threads.value = upsertSideThread(threads.value, session, parentId.value)
  }
  function remove(id: string) {
    threads.value = threads.value.filter(s => s.id !== id)
  }

  function onEvent(event: ServerEvent) {
    if (event.type === 'session.updated') {
      const s = event.session
      if (s.parentId === parentId.value || threads.value.some(t => t.id === s.id)) apply(s)
    } else if (event.type === 'session.removed') remove(event.sessionId)
  }

  let off: (() => void) | null = null
  onMounted(() => {
    off = api.subscribe(onEvent, () => void reload())
    void reload()
  })
  onBeforeUnmount(() => {
    off?.()
    off = null
    latest++
  })
  watch(parentId, () => {
    threads.value = []
    phase.value = 'loading'
    error.value = null
    void reload()
  })

  return { threads, phase, error, reload, apply, remove }
}
