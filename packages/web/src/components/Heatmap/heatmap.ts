export interface HeatmapDay {
  /** Local calendar day, YYYY-MM-DD. */
  date: string
  value: number
}

export interface HeatmapCell extends HeatmapDay {
  /** 0 = nothing, 1..levels = share of the busiest day. */
  level: number
}

/** Monday = 0 … Sunday = 6, for a YYYY-MM-DD read as a local date. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return (new Date(y!, m! - 1, d!).getDay() + 6) % 7
}

export function levelOf(value: number, max: number, levels: number): number {
  if (!(value > 0) || !(max > 0)) return 0
  return Math.min(levels, Math.max(1, Math.ceil((value / max) * levels)))
}

/** Columns of seven (Monday first); slots before the first day and after the last are null. */
export function heatmapWeeks(days: HeatmapDay[], levels: number): (HeatmapCell | null)[][] {
  if (!days.length) return []
  const max = Math.max(0, ...days.map(d => d.value))
  const cells: (HeatmapCell | null)[] = Array.from({ length: weekdayOf(days[0]!.date) }, () => null)
  for (const d of days) cells.push({ ...d, level: levelOf(d.value, max, levels) })
  while (cells.length % 7) cells.push(null)
  const weeks: (HeatmapCell | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}
