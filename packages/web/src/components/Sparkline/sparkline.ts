/** SVG path for values in a `width` x `height` box (y grows down), min at the bottom. Flat or single series sit mid-height. */
export function sparkPath(
  values: number[],
  width: number,
  height: number,
  pad = 1,
): { line: string; area: string } {
  const xs = values.filter(Number.isFinite)
  if (!xs.length) return { line: '', area: '' }
  const min = Math.min(...xs)
  const max = Math.max(...xs)
  const span = max - min
  const inner = height - pad * 2
  const step = xs.length > 1 ? width / (xs.length - 1) : 0
  const pts = xs.map((v, i) => {
    const x = xs.length > 1 ? i * step : width / 2
    const y = span === 0 ? height / 2 : pad + inner - ((v - min) / span) * inner
    return [round(x), round(y)] as const
  })
  if (pts.length === 1) pts.unshift([0, pts[0]![1]])
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ')
  const area = `${line} L${pts.at(-1)![0]} ${height} L${pts[0]![0]} ${height} Z`
  return { line, area }
}

const round = (n: number) => Math.round(n * 100) / 100
