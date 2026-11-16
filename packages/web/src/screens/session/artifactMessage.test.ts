// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { acceptSubmit, MAX_SUBMIT_BYTES } from './artifactMessage'

const win = {}
const frame = { source: win, artifactId: 4, version: 2 }
const submit = (over: Record<string, unknown> = {}) => ({
  type: 'odin.submit',
  artifactId: 4,
  version: 2,
  data: { choice: 'a' },
  ...over,
})

describe('acceptSubmit', () => {
  it('accepts a submit from the frame itself and returns the data', () => {
    const r = acceptSubmit({ source: win, data: submit() }, frame)
    expect(r).toEqual({ ok: true, data: { choice: 'a' }, json: '{"choice":"a"}' })
  })

  it('ignores a message from any other window', () => {
    expect(acceptSubmit({ source: {}, data: submit() }, frame)).toEqual({
      ok: false,
      reason: 'source',
    })
    expect(acceptSubmit({ source: null, data: submit() }, frame)).toEqual({
      ok: false,
      reason: 'source',
    })
  })

  it('ignores everything while the iframe is not mounted', () => {
    expect(acceptSubmit({ source: null, data: submit() }, { ...frame, source: null }).ok).toBe(
      false,
    )
    expect(
      acceptSubmit({ source: undefined, data: submit() }, { ...frame, source: undefined }).ok,
    ).toBe(false)
  })

  it('rejects other message types and non-objects', () => {
    expect(acceptSubmit({ source: win, data: submit({ type: 'other' }) }, frame)).toMatchObject({
      reason: 'type',
    })
    expect(acceptSubmit({ source: win, data: 'odin.submit' }, frame)).toMatchObject({
      reason: 'type',
    })
    expect(acceptSubmit({ source: win, data: null }, frame)).toMatchObject({ reason: 'type' })
  })

  it('rejects a submit for another artifact or version', () => {
    expect(acceptSubmit({ source: win, data: submit({ artifactId: 5 }) }, frame)).toMatchObject({
      reason: 'artifact',
    })
    expect(acceptSubmit({ source: win, data: submit({ version: 1 }) }, frame)).toMatchObject({
      reason: 'version',
    })
  })

  it('rejects data that is not JSON', () => {
    expect(acceptSubmit({ source: win, data: submit({ data: undefined }) }, frame)).toMatchObject({
      reason: 'shape',
    })
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(acceptSubmit({ source: win, data: submit({ data: cycle }) }, frame)).toMatchObject({
      reason: 'shape',
    })
    expect(acceptSubmit({ source: win, data: submit({ data: 10n }) }, frame)).toMatchObject({
      reason: 'shape',
    })
  })

  it('enforces 64 KB of JSON, counted in bytes', () => {
    const fits = 'x'.repeat(MAX_SUBMIT_BYTES - 2)
    expect(acceptSubmit({ source: win, data: submit({ data: fits }) }, frame).ok).toBe(true)
    expect(acceptSubmit({ source: win, data: submit({ data: fits + 'x' }) }, frame)).toMatchObject({
      reason: 'size',
    })
    // 3 bytes per character
    const wide = '€'.repeat(Math.ceil(MAX_SUBMIT_BYTES / 3))
    expect(acceptSubmit({ source: win, data: submit({ data: wide }) }, frame)).toMatchObject({
      reason: 'size',
    })
  })

  it('returns what was measured: values JSON cannot carry are gone', () => {
    const r = acceptSubmit(
      { source: win, data: submit({ data: { a: 1, f: () => 1, d: new Date(0) } }) },
      frame,
    )
    expect(r).toMatchObject({ ok: true, data: { a: 1, d: '1970-01-01T00:00:00.000Z' } })
  })
})
