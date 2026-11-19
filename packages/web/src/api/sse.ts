// The browser end of GET /api/events. EventSource reconnects by itself only on some failures, so this wraps it with
// the contract's rules (docs/contracts.md#sse): a watchdog that reconnects when nothing, not even a heartbeat,
// arrives for STALE_MS, a backoff between attempts, and an `onReconnect` call so callers can refetch REST state.
import type { ServerEvent, ServerEventType } from '@odin/shared/events'
import { STALE_MS } from '@odin/shared/events'

/** The slice of EventSource this client uses, so tests can drive it with a fake. */
export interface EventSourceLike {
  onopen: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  addEventListener(type: string, listener: (ev: { data: string }) => void): void
  close(): void
}

export interface EventStreamOptions {
  url?: string
  createSource?: (url: string) => EventSourceLike
  staleMs?: number
  /** First retry delay; doubles per failed attempt up to `maxBackoffMs`. */
  backoffMs?: number
  maxBackoffMs?: number
}

// A Record, not an array, so adding a ServerEvent type without listing it here fails to compile.
const EVENT_TYPES: Record<ServerEventType, true> = {
  'notebook.comm': true,
  'notebook.updated': true,
  'notebook.execution': true,
  'notebook.output': true,
  heartbeat: true,
  'project.updated': true,
  'project.removed': true,
  'session.updated': true,
  'session.removed': true,
  'session.event': true,
  'session.queue': true,
  'checkpoint.updated': true,
  'git.changed': true,
  'artifact.updated': true,
  'library.updated': true,
  'install.updated': true,
  'sync.status': true,
  notice: true,
}

/**
 * Opens the event stream and keeps it open. Heartbeats only feed the watchdog; every other event reaches
 * `listener`. `onReconnect` fires when a connection opens after an earlier one was lost, never on the first.
 * Returns a function that closes everything.
 */
export function connectEvents(
  listener: (event: ServerEvent) => void,
  onReconnect?: () => void,
  options: EventStreamOptions = {},
): () => void {
  const url = options.url ?? '/api/events'
  const create = options.createSource ?? ((u: string) => new EventSource(u) as EventSourceLike)
  const staleMs = options.staleMs ?? STALE_MS
  const baseBackoff = options.backoffMs ?? 1000
  const maxBackoff = options.maxBackoffMs ?? 15_000

  let source: EventSourceLike | null = null
  let stopped = false
  let everOpened = false
  let lost = false
  let attempt = 0
  let staleTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function armWatchdog() {
    clearTimeout(staleTimer)
    staleTimer = setTimeout(onLost, staleMs)
  }

  function onLost() {
    if (stopped) return
    clearTimeout(staleTimer)
    source?.close()
    source = null
    lost = true
    const delay = Math.min(maxBackoff, baseBackoff * 2 ** attempt)
    attempt += 1
    clearTimeout(retryTimer)
    retryTimer = setTimeout(open, delay)
  }

  function open() {
    if (stopped) return
    const es = create(url)
    source = es
    armWatchdog() // a connect that hangs counts as stale too
    es.onopen = () => {
      if (stopped || source !== es) return
      attempt = 0
      armWatchdog()
      if (everOpened && lost) onReconnect?.()
      everOpened = true
      lost = false
    }
    es.onerror = () => {
      if (source === es) onLost()
    }
    for (const type of Object.keys(EVENT_TYPES)) {
      es.addEventListener(type, ev => {
        if (stopped || source !== es) return
        armWatchdog()
        if (type === 'heartbeat') return
        let parsed: ServerEvent
        try {
          parsed = JSON.parse(ev.data) as ServerEvent
        } catch {
          return // a malformed frame is dropped; the stream carries on
        }
        listener(parsed)
      })
    }
  }

  open()

  return () => {
    stopped = true
    clearTimeout(staleTimer)
    clearTimeout(retryTimer)
    source?.close()
    source = null
  }
}
