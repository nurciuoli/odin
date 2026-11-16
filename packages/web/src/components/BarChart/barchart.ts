// Pure geometry for IuBarChart: ticks, bar slots and the rounded-end bar path. No DOM.

export interface BarDay {
  date: string
  /** One value per series, in series order. Diverging mode draws series 2 below the axis from its magnitude. */
  values: number[]
}

export type BarMode = 'grouped' | 'diverging'

/** Round-number ticks covering [min, max] (min <= 0 <= max), about `count` of them. */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [0]
  const rough = (max - min) / Math.max(1, count)
  const pow = 10 ** Math.floor(Math.log10(rough))
  const f = rough / pow
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Math.round(v / step) * step)
  }
  return out
}

/** The y domain: grouped runs 0..max; diverging runs -(largest series 2) .. largest series 1. */
export function domain(days: BarDay[], mode: BarMode): [number, number] {
  let hi = 0
  let lo = 0
  for (const d of days) {
    if (mode === 'diverging') {
      hi = Math.max(hi, d.values[0] ?? 0)
      lo = Math.min(lo, -Math.abs(d.values[1] ?? 0))
    } else {
      for (const v of d.values) hi = Math.max(hi, v)
    }
  }
  if (hi === 0 && lo === 0) hi = 1
  const ticks = niceTicks(lo, hi)
  if (mode !== 'diverging' || ticks.length < 2) {
    return [Math.min(lo, ticks[0] ?? lo), Math.max(hi, ticks[ticks.length - 1] ?? hi)]
  }
  // Diverging: whole tick steps on both sides of the axis, and at least one step on a side with any value, so a
  // small side next to a large one is never pinned to the edge.
  const step = ticks[1]! - ticks[0]!
  const top = hi > 0 ? Math.max(step, Math.ceil(hi / step) * step) : 0
  const bottom = lo < 0 ? Math.min(-step, Math.floor(lo / step) * step) : 0
  return [bottom, top]
}

/** Indices of the days that get an x tick: about `count`, always including the first. */
export function dateTickIndices(n: number, count: number): number[] {
  if (n <= 0) return []
  const step = Math.max(1, Math.ceil(n / Math.max(1, count)))
  const out: number[] = []
  for (let i = 0; i < n; i += step) out.push(i)
  return out
}

/** Width of one bar and its left offset inside a day's slot, leaving `gap` between bars. */
export function barSlot(slot: number, bars: number, gap: number, max = 16) {
  const w = Math.max(1, Math.min(max, (slot - gap * (bars + 1)) / bars))
  const total = w * bars + gap * (bars - 1)
  const left = (slot - total) / 2
  return { w, offsets: Array.from({ length: bars }, (_, i) => left + i * (w + gap)) }
}

/**
 * A bar from the baseline `y0` to `y1`, with the data end (y1) rounded by `r` and the baseline end square.
 * Works up or down; a zero-height bar draws nothing.
 */
export function barPath(x: number, w: number, y0: number, y1: number, r = 4): string {
  const h = Math.abs(y1 - y0)
  if (h < 0.01 || w <= 0) return ''
  const c = Math.min(r, h, w / 2)
  const f = (n: number) => +n.toFixed(2)
  if (y1 < y0) {
    return `M${f(x)} ${f(y0)}V${f(y1 + c)}Q${f(x)} ${f(y1)} ${f(x + c)} ${f(y1)}H${f(x + w - c)}Q${f(x + w)} ${f(y1)} ${f(x + w)} ${f(y1 + c)}V${f(y0)}Z`
  }
  return `M${f(x)} ${f(y0)}V${f(y1 - c)}Q${f(x)} ${f(y1)} ${f(x + c)} ${f(y1)}H${f(x + w - c)}Q${f(x + w)} ${f(y1)} ${f(x + w)} ${f(y1 - c)}V${f(y0)}Z`
}

/** "2026-11-09" as a short label ("9 Nov"), read as a local date. */
export function shortDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  if (!y || !m || !d) return date
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
