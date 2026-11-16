import type { InjectionKey, Ref } from 'vue'

/** What a rail shares with its steps (and nested rails). */
export interface RailContext {
  /** The clock for elapsed time, ms epoch; undefined = no elapsed shown. */
  now: Ref<number | undefined>
  /** Directory file paths are shown relative to. */
  root: Ref<string | null | undefined>
  /** Steps that were already there when the rail mounted: they don't unfurl. */
  initial: Set<string>
}

export const RAIL_KEY: InjectionKey<RailContext> = Symbol('iu-rail')

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
