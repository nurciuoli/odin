// Motion helpers: read durations from the tokens rather than repeating literals, and honour reduced motion.

export function reducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
}

/** A time token (`--iu-dur-fold`) in ms. */
export function tokenMs(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return fallback
  return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : n
}

export function tokenString(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}
