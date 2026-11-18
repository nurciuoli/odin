// Storm clouds over the flock. Two soft cloud banks slide in from the left and right edges while a session is running
// and drift back out when none is; a faint flash of cool light inside the clouds marks a session that finished or
// needs you. The clouds are painted once into offscreen canvases (layered radial gradients, lightly blurred) and then
// only moved and cross-faded, so a frame costs a few drawImage calls. Coordinates are CSS pixels.
export type FlashKind = 'done' | 'attention'

export interface StormColors {
  /** cloud body */
  cloud: string
  /** flash glow (cool, never the accent) */
  glow: string
  /** cloud tops and flash-lit cloud */
  lit: string
}

interface Flash {
  t0: number
  kind: FlashKind
  side: 0 | 1 | 2
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1)
  return t * t * (3 - 2 * t)
}

/** A CSS colour as [r, g, b], so gradients fade to the same hue instead of to transparent black. */
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

/** Seconds for the clouds to roll in (time constant), to roll out, and how long a flash holds some cloud in view. */
export const STORM = { inTau: 7, outTau: 10, hold: 5, reach: 0.42, depth: 0.5 }

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Puff {
  x: number
  y: number
  r: number
}

/** Lobes of one cumulus bank in bank coordinates: wide, flat-based, tall at the outer edge, tapering inward. */
function puffsFor(seed: number, bw: number, bh: number): Puff[] {
  const rnd = rng(seed)
  const base = bh * 0.78
  const out: Puff[] = []
  const tier = (count: number, y: number, r: number, from: number, to: number) => {
    for (let i = 0; i < count; i++) {
      const u = count === 1 ? from : from + ((to - from) * i) / (count - 1)
      const taper = 1 - 0.55 * u
      const pr = r * taper * (0.8 + rnd() * 0.4)
      out.push({
        x: bw * u + (rnd() - 0.5) * bw * 0.06,
        y: Math.min(base - pr * 0.5, y * (0.8 + 0.2 * taper) + (rnd() - 0.5) * bh * 0.06),
        r: pr,
      })
    }
  }
  tier(7, base, bh * 0.26, 0.02, 0.92)
  tier(5, bh * 0.5, bh * 0.27, 0.06, 0.76)
  tier(3, bh * 0.28, bh * 0.2, 0.08, 0.46)
  return out
}

/**
 * Paint one bank into a canvas: a soft body, brighter tops, a shaded underside, and small billows along the edges.
 * `gain` scales every alpha, so the same painting serves as the dim resting cloud and the lit flash version.
 */
function paintBank(
  el: HTMLCanvasElement,
  puffs: Puff[],
  bw: number,
  bh: number,
  scale: number,
  body: [number, number, number],
  top: [number, number, number],
  gain: number,
  seed: number,
) {
  const g = el.getContext('2d')
  if (!g) return
  const rnd = rng(seed)
  g.setTransform(scale, 0, 0, scale, 0, 0)
  g.clearRect(0, 0, bw, bh)
  const blob = (x: number, y: number, r: number, c: [number, number, number], a: number) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r)
    grad.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a * gain})`)
    grad.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},${a * gain * 0.55})`)
    grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`)
    g.fillStyle = grad
    g.fillRect(x - r, y - r, r * 2, r * 2)
  }
  g.filter = `blur(${Math.max(2.5, bh * 0.04)}px)`
  // body: each lobe as a wide, soft disc
  for (const p of puffs) blob(p.x, p.y, p.r * 1.2, body, 0.4)
  // billows: small soft blobs just inside each lobe's edge give the cauliflower texture
  for (const p of puffs) {
    for (let i = 0; i < 7; i++) {
      const a = rnd() * 6.2832
      const d = p.r * (0.55 + rnd() * 0.3)
      blob(p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, p.r * (0.3 + rnd() * 0.22), body, 0.16)
    }
  }
  // tops: lit crescents on the upper left of each lobe
  for (const p of puffs) {
    blob(p.x - p.r * 0.18, p.y - p.r * 0.34, p.r * 0.62, top, 0.2)
    blob(p.x - p.r * 0.1, p.y - p.r * 0.5, p.r * 0.34, top, 0.16)
  }
  g.filter = 'none'
  // shade the underside and keep the base flat: fade everything out toward the bottom
  g.globalCompositeOperation = 'destination-out'
  const fall = g.createLinearGradient(0, bh * 0.52, 0, bh * 0.8)
  fall.addColorStop(0, 'rgba(0,0,0,0)')
  fall.addColorStop(0.6, 'rgba(0,0,0,0.55)')
  fall.addColorStop(1, 'rgba(0,0,0,1)')
  g.fillStyle = fall
  g.fillRect(0, 0, bw, bh)
  // the leading edge dissolves into wisps instead of ending
  const lead = g.createLinearGradient(bw * 0.62, 0, bw, 0)
  lead.addColorStop(0, 'rgba(0,0,0,0)')
  lead.addColorStop(1, 'rgba(0,0,0,1)')
  g.fillStyle = lead
  g.fillRect(0, 0, bw, bh)
  g.globalCompositeOperation = 'source-over'
}

export function createStorm(w: number, h: number, scale = 1) {
  const bw = w * STORM.reach
  const bh = h * STORM.depth
  const puffs = [puffsFor(11, bw, bh), puffsFor(47, bw, bh)]
  // offscreen paintings, built on the first draw (they need the theme colours): [side][0 resting, 1 lit]
  let sprites: HTMLCanvasElement[][] | null = null
  let paintedWith = ''
  function build(ctx: CanvasRenderingContext2D, c: StormColors) {
    const key = `${c.cloud}|${c.lit}`
    if (sprites && paintedWith === key) return sprites
    const body = rgb(ctx, c.cloud)
    const top = rgb(ctx, c.lit)
    sprites = [0, 1].map(side =>
      [0.9, 2.1].map((gain, lit) => {
        const el = document.createElement('canvas')
        el.width = Math.max(1, Math.round(bw * scale))
        el.height = Math.max(1, Math.round(bh * scale))
        paintBank(el, puffs[side]!, bw, bh, scale, lit ? top : body, top, gain, 90 + side)
        return el
      }),
    )
    paintedWith = key
    return sprites
  }
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
      const art = build(ctx, c)
      const e = smooth(0, 1, gather) // ease the crawl so it starts and ends slowly
      const present = smooth(0, 0.25, gather) // fade in as the bank arrives
      const calm = opts.calm ? 0.5 : 1 // reduced motion: lower contrast
      const level = (side: 0 | 1) =>
        flashes.reduce(
          (m, f) => (f.side === 2 || f.side === side ? Math.max(m, envelope(f, t - f.t0)) : m),
          0,
        )
      for (const side of [0, 1] as const) {
        const lit = level(side) * calm
        const lead = e * bw // the bank's leading edge sits this far in from its canvas edge
        const sway = opts.drift ? Math.sin(t * 0.09 + side * 2.1) * 6 : 0
        const bob = opts.drift ? Math.sin(t * 0.13 + side) * 2 : 0
        const x = (side === 0 ? lead - bw : w - lead) + sway
        const y = 4 + bob
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
        ctx.save()
        if (side === 1) {
          // the right bank is the same painting mirrored, so its lit tops face the middle too
          ctx.translate(x + bw, y)
          ctx.scale(-1, 1)
        } else ctx.translate(x, y)
        ctx.globalAlpha = present
        ctx.drawImage(art[side]![0]!, 0, 0, bw, bh)
        if (lit > 0.01) {
          ctx.globalAlpha = present * clamp(lit * 1.1, 0, 1)
          ctx.drawImage(art[side]![1]!, 0, 0, bw, bh)
        }
        ctx.restore()
      }
      ctx.globalAlpha = 1
    },
  }
}
