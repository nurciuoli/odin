// useNow — the reference clock for relative labels ("Today", "2d ago") and for
// timestamps stamped on user actions. Defaults to the real clock; a subtree can
// pin it with provideNow so fixture-driven screens read the same on any day.
import { inject, provide, type InjectionKey } from 'vue'

const NOW_KEY: InjectionKey<() => number> = Symbol('iu-now')

/** pin the clock for this component's subtree (ISO string or epoch ms) */
export function provideNow(at: string | number) {
  const ms = typeof at === 'string' ? Date.parse(at) : at
  provide(NOW_KEY, () => ms)
}

/** the current reference time in epoch ms — call it, don't cache it */
export function useNow(): () => number {
  return inject(NOW_KEY, Date.now)
}

/** the reference time as an ISO string */
export function useNowIso(): () => string {
  const now = useNow()
  return () => new Date(now()).toISOString()
}
