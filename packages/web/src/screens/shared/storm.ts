// Storm clouds over the flock. Two banks of dots crawl in from the left and right edges while a session is running
// and drift back out when none is; a faint flash of cool light inside the clouds marks a session that finished or
// needs you. Pure drawing + easing, no DOM: Murmuration owns the canvas. Coordinates are CSS pixels.
export type FlashKind = 'done' | 'attention'

export interface StormColors {
  /** cloud dots */
  cloud: string
  /** flash glow (cool, never the accent) */
  glow: string
  /** dots lit by a flash */
  lit: string
}

interface Dot {
  /** 0 = outer edge of the bank, 1 = leading (inner) edge */
  u: number
  /** 0 = top of the canvas, 1 = bottom of the bank */
  v: number
  /** how dense the cloud is here, 0..1 */
  d: number
  phase: number
  r: number
}
interface Flash {
  t0: number
  kind: FlashKind
  side: 0 | 1 | 2
}

/** A CSS colour as [r, g, b], so a gradient can fade to the same hue instead of to transparent black. */
const rgbCache = new Map<string, [number, number, number]>()
function rgb(ctx: CanvasRenderingContext2D, color: string): [number, number, number] {
  let out = rgbCache.get(color)
  if (!out) {
    const keep = ctx.fillStyle
    ctx.fillStyle = color
    const hex = String(ctx.fillStyle)
    ctx.fillStyle = keep
    const n = Number.parseInt(hex.slice(1, 7), 16)
    out = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    rgbCache.set(color, out)
  }
  return out
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** Seconds for the clouds to roll in (time constant), to roll out, and how long a flash holds some cloud in view. */
export const STORM = { inTau: 7, outTau: 10, hold: 5, reach: 0.4, depth: 0.5 }

function bank(seed: number, spacing: number, w: number, h: number): Dot[] {
  let s = seed
  const rnd = () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const bw = w * STORM.reach
  const bh = h * STORM.depth
  // a handful of puffs, big and low at the outer edge, small and high toward the leading edge
  const puffs = Array.from({ length: 9 }, (_, i) => {
    const u = i / 8
    return {
      x: bw * (0.08 + u * 0.82) + (rnd() - 0.5) * bw * 0.1,
      y: bh * (0.34 + 0.2 * (1 - u)) + (rnd() - 0.5) * bh * 0.16,
      r: bh * (0.34 + 0.24 * (1 - u)) * (0.85 + rnd() * 0.4),
    }
  })
  const dots: Dot[] = []
  for (let y = 0; y < bh; y += spacing) {
    for (let x = 0; x < bw; x += spacing) {
      const px = x + (rnd() - 0.5) * spacing * 0.7
      const py = y + (rnd() - 0.5) * spacing * 0.7
      let d = 0
      for (const p of puffs) {
        const dist = Math.hypot(px - p.x, (py - p.y) * 1.25) / p.r
        d = Math.max(d, 1 - dist * dist)
      }
      d *= smooth(bh, bh * 0.62, py) // flat, soft underside
      d *= smooth(bw, bw * 0.7, px) // never a hard edge at the leading side
      d = d * 0.9 + (rnd() - 0.5) * 0.08
      if (d < 0.08) continue
      dots.push({
        u: px / bw,
        v: py / bh,
        d: clamp(d, 0, 1),
        phase: rnd() * 6.28,
        r: 0.7 + d * 0.9,
      })
    }
  }
  return dots
}

export function createStorm(w: number, h: number) {
  const spacing = w < 520 ? 6 : 7
  const left = bank(11, spacing, w, h)
  const right = bank(47, spacing, w, h)
  const bw = w * STORM.reach
  const bh = h * STORM.depth
  let gather = 0
  let holdUntil = -1
  let flashes: Flash[] = []
  let next: 0 | 1 = 0

  /** Flash envelope 0..1 at age `a` seconds: a quick rise and a long decay; attention flickers twice. */
  function envelope(f: Flash, a: number): number {
    if (a < 0) return 0
    const pulse = (t: number, k: number, tau: number) =>
      t < 0 ? 0 : k * (1 - Math.exp(-t / 0.05)) * Math.exp(-t / tau)
    return f.kind === 'attention'
      ? Math.min(1, pulse(a, 1, 0.3) + pulse(a - 0.28, 0.7, 0.42))
      : pulse(a, 0.75, 0.55)
  }
  const life = (k: FlashKind) => (k === 'attention' ? 2.4 : 2.2)

  return {
    /** Advance the weather. `running` is how many sessions are running right now. */
    step(t: number, dt: number, running: number) {
      const intensity = running > 0 ? Math.min(1, 0.72 + 0.14 * (running - 1)) : 0
      const target = Math.max(intensity, t < holdUntil ? 0.5 : 0)
      const tau = target > gather ? STORM.inTau : STORM.outTau
      gather += (target - gather) * (1 - Math.exp(-dt / tau))
      flashes = flashes.filter(f => t - f.t0 < life(f.kind))
    },
    flash(t: number, kind: FlashKind) {
      holdUntil = Math.max(holdUntil, t + STORM.hold)
      // attention lights both banks; a finished session lights one, alternating
      const side: 0 | 1 | 2 = kind === 'attention' ? 2 : next
      if (kind === 'done') next = next === 0 ? 1 : 0
      flashes.push({ t0: t, kind, side })
    },
    /** 0..1 how far the clouds have come in (for the flock to lean on). */
    get gather() {
      return gather
    },
    /** Jump straight to a settled weather (reduced motion, first paint). */
    settle(running: number) {
      gather = running > 0 ? Math.min(1, 0.72 + 0.14 * (running - 1)) : 0
    },
    draw(
      ctx: CanvasRenderingContext2D,
      t: number,
      c: StormColors,
      opts: { drift: boolean; calm?: boolean } = { drift: true },
    ) {
      if (gather < 0.01 && !flashes.length) return
      const e = smooth(0, 1, gather) // ease the crawl so it starts and ends slowly
      const present = smooth(0, 0.2, gather) // dots fade in as the bank arrives
      const calm = opts.calm ? 0.5 : 1 // reduced motion: lower contrast
      const level = (side: 0 | 1) =>
        flashes.reduce(
          (m, f) => (f.side === 2 || f.side === side ? Math.max(m, envelope(f, t - f.t0)) : m),
          0,
        )
      for (const side of [0, 1] as const) {
        const lit = level(side) * calm
        const dots = side === 0 ? left : right
        const lead = e * bw // the bank's leading edge sits this far in from its canvas edge
        const x0 = side === 0 ? lead - bw : w - lead + bw
        if (lit > 0.01) {
          const gx =
            side === 0 ? Math.max(lead * 0.6, bw * 0.15) : w - Math.max(lead * 0.6, bw * 0.15)
          const gy = bh * 0.4
          const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, h * 1.1)
          const [r, gr, b] = rgb(ctx, c.glow)
          for (const [at, k] of [
            [0, 1],
            [0.35, 0.55],
            [0.7, 0.16],
            [1, 0],
          ] as const)
            g.addColorStop(at, `rgba(${r},${gr},${b},${k})`)
          ctx.globalAlpha = 0.18 * lit
          ctx.fillStyle = g
          ctx.fillRect(0, 0, w, h)
        }
        for (const lightBatch of [false, true]) {
          if (lightBatch && lit < 0.02) break
          ctx.fillStyle = lightBatch ? c.lit : c.cloud
          ctx.beginPath()
          for (const d of dots) {
            const x = side === 0 ? x0 + d.u * bw : x0 - d.u * bw
            if (x < -4 || x > w + 4) continue
            const y = d.v * bh + (opts.drift ? Math.sin(t * 0.35 + d.phase) * 1.1 : 0)
            const a = Math.min(0.75, 0.18 + d.d * 0.7) * present
            if (lightBatch) {
              const k = clamp((d.d - 0.3) * 1.5, 0, 1) * lit // only the denser dots catch the light
              if (k < 0.04) continue
              ctx.globalAlpha = Math.min(0.95, a + k * 0.6)
            } else ctx.globalAlpha = a
            ctx.moveTo(x + d.r, y)
            ctx.arc(x, y, d.r, 0, 6.2832)
          }
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1
    },
  }
}
