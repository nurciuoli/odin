// What the artifact frame accepts from the page inside its iframe. The iframe is sandboxed without the
// same-origin grant, so its origin is opaque and an origin check is useless: the only identity is `source`, which
// must be this frame's own contentWindow. Everything else is shape and size.

/** Contract: data in a submit is at most 64 KB of JSON. */
export const MAX_SUBMIT_BYTES = 64 * 1024

export const SUBMIT_TYPE = 'odin.submit'

export interface FrameIdentity {
  /** This iframe's `contentWindow`. null while the iframe isn't mounted: nothing is accepted. */
  source: unknown
  artifactId: number
  version: number
}

export type SubmitResult =
  | { ok: true; data: unknown; json: string }
  | { ok: false; reason: 'source' | 'type' | 'artifact' | 'version' | 'shape' | 'size' }

/**
 * Decides whether a `message` event is a submit from this frame. `data` comes back as parsed from its own JSON, so
 * what is confirmed and posted is exactly what was measured (no Dates, functions or cycles survive).
 */
export function acceptSubmit(
  event: { source: unknown; data: unknown },
  frame: FrameIdentity,
): SubmitResult {
  if (frame.source === null || frame.source === undefined || event.source !== frame.source)
    return { ok: false, reason: 'source' }
  const msg = event.data
  if (!msg || typeof msg !== 'object') return { ok: false, reason: 'type' }
  const m = msg as Record<string, unknown>
  if (m.type !== SUBMIT_TYPE) return { ok: false, reason: 'type' }
  if (m.artifactId !== frame.artifactId) return { ok: false, reason: 'artifact' }
  if (m.version !== frame.version) return { ok: false, reason: 'version' }
  let json: string | undefined
  try {
    json = JSON.stringify(m.data)
  } catch {
    return { ok: false, reason: 'shape' }
  }
  if (json === undefined) return { ok: false, reason: 'shape' }
  if (new TextEncoder().encode(json).length > MAX_SUBMIT_BYTES) return { ok: false, reason: 'size' }
  return { ok: true, data: JSON.parse(json), json }
}
