// Squarified treemap: lays weighted items out in a box so every cell stays close to square.
export interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

interface Sized {
  id: string
  area: number
}

interface Frame {
  x: number
  y: number
  w: number
  h: number
}

function worst(row: Sized[], side: number): number {
  const sum = row.reduce((t, i) => t + i.area, 0)
  const areas = row.map(i => i.area)
  const max = Math.max(...areas)
  const min = Math.min(...areas)
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min))
}

function place(row: Sized[], f: Frame, out: Rect[]): Frame {
  const sum = row.reduce((t, i) => t + i.area, 0)
  if (f.w >= f.h) {
    const width = f.h === 0 ? 0 : sum / f.h
    let y = f.y
    for (const i of row) {
      const h = width === 0 ? 0 : i.area / width
      out.push({ id: i.id, x: f.x, y, w: width, h })
      y += h
    }
    return { x: f.x + width, y: f.y, w: Math.max(0, f.w - width), h: f.h }
  }
  const height = f.w === 0 ? 0 : sum / f.w
  let x = f.x
  for (const i of row) {
    const w = height === 0 ? 0 : i.area / height
    out.push({ id: i.id, x, y: f.y, w, h: height })
    x += w
  }
  return { x: f.x, y: f.y + height, w: f.w, h: Math.max(0, f.h - height) }
}

export function treemap(
  items: { id: string; value: number }[],
  width: number,
  height: number,
): Rect[] {
  if (width <= 0 || height <= 0) return []
  const clean = items.filter(i => i.value > 0)
  const total = clean.reduce((t, i) => t + i.value, 0)
  if (!total) return []
  const queue: Sized[] = clean
    .slice()
    .sort((a, b) => b.value - a.value)
    .map(i => ({ id: i.id, area: (i.value / total) * width * height }))
  const out: Rect[] = []
  let frame: Frame = { x: 0, y: 0, w: width, h: height }
  let row: Sized[] = []
  while (queue.length) {
    const next = queue[0]!
    const side = Math.min(frame.w, frame.h)
    if (!row.length || worst(row, side) >= worst([...row, next], side)) {
      row.push(next)
      queue.shift()
    } else {
      frame = place(row, frame, out)
      row = []
    }
  }
  if (row.length) place(row, frame, out)
  return out
}
