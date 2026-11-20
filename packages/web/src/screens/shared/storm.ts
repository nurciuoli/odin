// The sky above Home. Two lanes of cumulus drift across the whole width of the screen in opposite directions, an
// endless stream: each lane sends a new cloud in from its edge as the last one clears it, and clouds leave by the far
// edge. The bank starts below the app bar, with clear ground under the hairline, and each cloud carries a faint cell
// grid that a slow wave brightens. Nothing tints the flock; the only light on it is a flash that marks a session that
// finished or needs you. Each cloud is painted once into an offscreen canvas (layered radial gradients, lightly
// blurred, then the grid), so a frame is a few drawImage calls. Coordinates are CSS pixels.
export type FlashKind = 'done' | 'attention'

export interface StormColors {
  /** cloud body */
  cloud: string
  /** page ground, so the body fades into the pane */
  ground: string
  /** flash glow (cool, never the accent) */
  glow: string
  /** cloud tops and flash-lit cloud */
  lit: string
}

interface Flash {
  t0: number
  kind: FlashKind
  /** where along the width the light is, 0..1 */
  at: number
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

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

/**
 * Timing, in seconds. The sky fades out over `outTau` once the weather ends; Home waits `lag` after every session
 * has finished and been read before it does. Clouds cross a 1440px screen in about a minute.
 */
export const STORM = { lag: 60, inTau: 1.5, outTau: 16 }

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

/** Lobes of one cumulus in cloud coordinates: a flat base, a rounded crown, tapering to both ends. */
function puffsFor(seed: number, cw: number, ch: number): Puff[] {
  const rnd = rng(seed)
  const base = ch * 0.78
  const bell = (u: number) => Math.pow(Math.sin(Math.PI * clamp(u, 0.02, 0.98)), 0.6)
  const out: Puff[] = []
  const tier = (count: number, y: number, r: number, from: number, to: number) => {
    for (let i = 0; i < count; i++) {
      const u = count === 1 ? (from + to) / 2 : from + ((to - from) * i) / (count - 1)
      const pr = r * (0.35 + 0.65 * bell(u)) * (0.85 + rnd() * 0.3)
      out.push({
        x: cw * u + (rnd() - 0.5) * cw * 0.04,
        y: Math.min(base - pr * 0.5, y + (rnd() - 0.5) * ch * 0.08),
        r: pr,
      })
    }
  }
  const row = Math.max(4, Math.round(cw / (ch * 0.62)))
  tier(row, base, ch * 0.3, 0.06, 0.94)
  tier(Math.max(2, Math.round(row * 0.6)), ch * 0.5, ch * 0.3, 0.16, 0.84)
  tier(Math.max(1, Math.round(row * 0.28)), ch * 0.3, ch * 0.24, 0.3, 0.7)
  return out
}

/**
 * Paint one cloud into a canvas: a soft body, brighter tops, a shaded underside, and small billows along the edges.
 * `gain` scales every alpha, so the same painting serves as the dim resting cloud and the lit flash version.
 */
function paintCloud(
  el: HTMLCanvasElement,
  puffs: Puff[],
  cw: number,
  ch: number,
  scale: number,
  body: [number, number, number],
  top: [number, number, number],
  gain: number,
  seed: number,
  shade: number,
) {
  const g = el.getContext('2d')
  if (!g) return
  const rnd = rng(seed)
  g.setTransform(scale, 0, 0, scale, 0, 0)
  g.clearRect(0, 0, cw, ch)
  const blob = (x: number, y: number, r: number, c: [number, number, number], a: number) => {
    const grad = g.createRadialGradient(x, y, 0, x, y, r)
    grad.addColorStop(0, `rgba(${c[0]},${c[1]},${c[2]},${a * gain})`)
    grad.addColorStop(0.5, `rgba(${c[0]},${c[1]},${c[2]},${a * gain * 0.55})`)
    grad.addColorStop(1, `rgba(${c[0]},${c[1]},${c[2]},0)`)
    g.fillStyle = grad
    g.fillRect(x - r, y - r, r * 2, r * 2)
  }
  g.filter = `blur(${Math.max(2, ch * 0.035)}px)`
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
  // storm-dark underbelly: a slate shadow over the lower half of every lobe, only where there is cloud
  g.globalCompositeOperation = 'source-atop'
  const belly = g.createLinearGradient(0, ch * 0.3, 0, ch * 0.78)
  belly.addColorStop(0, 'rgba(10,11,14,0)')
  belly.addColorStop(1, `rgba(10,11,14,${shade})`)
  g.fillStyle = belly
  g.fillRect(0, 0, cw, ch)
  // keep the base flat and let the underside dissolve, so nothing hangs low over the flock
  g.globalCompositeOperation = 'destination-out'
  const fall = g.createLinearGradient(0, ch * 0.5, 0, ch * 0.8)
  fall.addColorStop(0, 'rgba(0,0,0,0)')
  fall.addColorStop(0.6, 'rgba(0,0,0,0.6)')
  fall.addColorStop(1, 'rgba(0,0,0,1)')
  g.fillStyle = fall
  g.fillRect(0, 0, cw, ch)
  g.globalCompositeOperation = 'source-over'
  layLattice(el, scale, top)
}

/**
 * A quiet cell grid laid into the cloud, only where it already has body. Cells stay put; a slow wave in `draw`
 * is what brightens them. No flicker and no offset slices.
 */
function layLattice(el: HTMLCanvasElement, scale: number, tint: [number, number, number]) {
  const g = el.getContext('2d')
  if (!g) return
  const w = el.width
  const h = el.height
  let src: Uint8ClampedArray
  try {
    src = g.getImageData(0, 0, w, h).data
  } catch {
    return
  }
  const cell = Math.max(3, Math.round(4 * scale))
  g.save()
  g.setTransform(1, 0, 0, 1, 0, 0)
  g.globalCompositeOperation = 'source-atop'
  g.fillStyle = `rgb(${tint[0]},${tint[1]},${tint[2]})`
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      let a = 0
      let n = 0
      const x1 = Math.min(w, x + cell)
      const y1 = Math.min(h, y + cell)
      for (let yy = y; yy < y1; yy += 2) {
        for (let xx = x; xx < x1; xx += 2) {
          a += src[(yy * w + xx) * 4 + 3] ?? 0
          n++
        }
      }
      const alpha = n ? a / (n * 255) : 0
      if (alpha < 0.1) continue
      const inset = Math.max(1, Math.round(cell * 0.28))
      g.globalAlpha = Math.min(0.18, 0.04 + alpha * 0.14)
      g.fillRect(x + inset, y + inset, Math.max(1, cell - inset * 2), Math.max(1, cell - inset * 2))
    }
  }
  g.restore()
}

/** Cloud shapes in the pool: [width, seed]. Heights follow from the width. */
const SHAPES = [
  [300, 11],
  [460, 47],
  [360, 73],
  [520, 29],
] as const
const ASPECT = 0.3

interface Lane {
  /** +1 drifts left to right, -1 right to left */
  dir: 1 | -1
  /** px/s at a 1440px-wide screen */
  speed: number
  /** extra drop below the app-bar clearance, and how big its clouds are */
  y: number
  size: number
  alpha: number
}
/**
 * Clear ground between the app bar and the first cloud tone. Lane `y` is an extra drop below that, scaled with the
 * screen. The bar height itself is added when drawing, so a taller desktop title bar keeps the same gap.
 */
const CLEAR = 16
/** The far lane is smaller, paler and slower; the near lane crosses it the other way, lower in the pane. */
const LANES: Lane[] = [
  { dir: -1, speed: 11, y: 12, size: 0.78, alpha: 0.72 },
  { dir: 1, speed: 19, y: 64, size: 1, alpha: 0.88 },
]

interface Cloud {
  lane: number
  shape: number
  /** left edge */
  x: number
  w: number
  h: number
  /** phase of the slow bob */
  bob: number
  /** clear space to leave before the next cloud follows it in */
  gap: number
}

export function createStorm(w: number, _h: number, scale = 1) {
  const unit = clamp(w / 1440, 0.6, 1.25)
  const rnd = rng(5)
  let clouds: Cloud[] = []
  let weather = 0
  let flashes: Flash[] = []
  let nextFlash = 0
  // offscreen paintings, built on the first draw (they need the theme colours): [shape][0 resting, 1 lit]
  let sprites: HTMLCanvasElement[][] | null = null
  let paintedWith = ''

  function build(ctx: CanvasRenderingContext2D, c: StormColors) {
    const key = `${c.cloud}|${c.ground}|${c.lit}|${scale}`
    if (sprites && paintedWith === key) return sprites
    const mix = (a: number[], b: number[], k: number) =>
      a.map((v, i) => v + (b[i]! - v) * k) as [number, number, number]
    const flash = rgb(ctx, c.lit)
    // resting clouds fade toward the page ground; the lit painting keeps the theme's bright text for the flash
    const body = mix(rgb(ctx, c.cloud), rgb(ctx, c.ground), 0.45)
    const top = mix(flash, body, 0.7)
    sprites = SHAPES.map(([sw, seed]) => {
      const cw = sw * unit
      const ch = cw * ASPECT
      const puffs = puffsFor(seed, cw, ch)
      return [1.4, 1.85].map((gain, lit) => {
        const el = document.createElement('canvas')
        el.width = Math.max(1, Math.round(cw * scale))
        el.height = Math.max(1, Math.round(ch * scale))
        paintCloud(
          el,
          puffs,
          cw,
          ch,
          scale,
          lit ? flash : body,
          lit ? flash : top,
          gain,
          seed + 90,
          lit ? 0.22 : 0.34,
        )
        return el
      })
    })
    paintedWith = key
    return sprites
  }

  function spawn(lane: number) {
    const l = LANES[lane]!
    const shape = Math.floor(rnd() * SHAPES.length)
    const cw = SHAPES[shape]![0] * unit * l.size
    clouds.push({
      lane,
      shape,
      x: l.dir === 1 ? -cw : w,
      w: cw,
      h: cw * ASPECT,
      bob: rnd() * 6.2832,
      gap: (30 + rnd() * 150) * unit,
    })
  }
  /** Is the newest cloud of a lane far enough in for the next to follow it? */
  function roomFor(lane: number) {
    const l = LANES[lane]!
    let last: Cloud | undefined
    for (const c of clouds) if (c.lane === lane) last = c
    if (!last) return true
    return l.dir === 1 ? last.x >= last.gap : last.x + last.w <= w - last.gap
  }
  function move(dt: number, feed: boolean) {
    for (const c of clouds) {
      const l = LANES[c.lane]!
      c.x += l.dir * l.speed * unit * dt
    }
    clouds = clouds.filter(c => c.x < w + 1 && c.x + c.w > -1)
    if (feed) for (let lane = 0; lane < LANES.length; lane++) if (roomFor(lane)) spawn(lane)
  }

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

  /** Where the next flash lands: scattered along the width, never the same place twice in a row. */
  const SPOTS = [0.62, 0.24, 0.8, 0.41, 0.12, 0.9, 0.5, 0.33]

  return {
    /** Advance the weather. `active` is whether there is weather: a session is running, waiting or unread. */
    step(t: number, dt: number, active: boolean) {
      weather +=
        ((active ? 1 : 0) - weather) * (1 - Math.exp(-dt / (active ? STORM.inTau : STORM.outTau)))
      move(dt, active)
      flashes = flashes.filter(f => t - f.t0 < life(f.kind))
    },
    flash(t: number, kind: FlashKind) {
      flashes.push({ t0: t, kind, at: SPOTS[nextFlash++ % SPOTS.length]! })
    },
    /** 0..1 how present the weather is (the flock leans on it). */
    get gather() {
      return weather
    },
    /** Jump straight to a settled sky (reduced motion, first paint): the stream already running, or nothing. */
    settle(active: boolean) {
      clouds = []
      weather = active ? 1 : 0
      if (!active) return
      // run the lanes forward until they are full across the screen
      for (let i = 0; i < Math.ceil((w / (LANES[1]!.speed * unit) + 20) * 4); i++) move(0.25, true)
    },
    draw(
      ctx: CanvasRenderingContext2D,
      t: number,
      c: StormColors,
      opts: { drift: boolean; calm?: boolean; bar?: number } = { drift: true },
    ) {
      if (weather < 0.01 && !flashes.length) return
      const art = build(ctx, c)
      const calm = opts.calm ? 0.5 : 1 // reduced motion: lower contrast
      const bar = opts.bar && opts.bar > 0 ? opts.bar : 48
      const floor = bar + CLEAR
      const level = (at: number) =>
        flashes.reduce((m, f) => {
          const k = 0.3 + 0.7 * Math.exp(-(((at - f.at) / 0.3) ** 2))
          return Math.max(m, envelope(f, t - f.t0) * k)
        }, 0)
      ctx.save()
      ctx.beginPath()
      ctx.rect(0, bar, w, 4000)
      ctx.clip()
      // the light of a flash: a cool glow around where it struck, reaching down past the clouds
      const [hr, hg, hb] = rgb(ctx, c.glow)
      const [lr, lg, lb] = rgb(ctx, c.lit)
      for (const f of flashes) {
        const lit = envelope(f, t - f.t0) * calm
        if (lit < 0.01) continue
        const gx = f.at * w
        const gy = floor + 28 * unit
        const g = ctx.createRadialGradient(gx, gy, 0, gx, gy, w * 0.36)
        for (const [at, k] of [
          [0, 1],
          [0.35, 0.55],
          [0.7, 0.16],
          [1, 0],
        ] as const)
          g.addColorStop(at, `rgba(${hr},${hg},${hb},${k})`)
        ctx.globalAlpha = 0.18 * lit
        ctx.fillStyle = g
        ctx.fillRect(0, bar, w, gy + w * 0.36)
      }
      // far lane first, so the near lane crosses in front of it
      for (const lane of [0, 1]) {
        const l = LANES[lane]!
        for (const cloud of clouds) {
          if (cloud.lane !== lane) continue
          const y = floor + l.y * unit + (opts.drift ? Math.sin(t * 0.13 + cloud.bob) * 2 : 0)
          const here = level((cloud.x + cloud.w / 2) / w) * calm
          ctx.globalAlpha = weather * l.alpha
          ctx.drawImage(art[cloud.shape]![0]!, cloud.x, y, cloud.w, cloud.h)
          if (here > 0.01) {
            ctx.globalAlpha = weather * l.alpha * clamp(here * 1.1, 0, 1)
            ctx.drawImage(art[cloud.shape]![1]!, cloud.x, y, cloud.w, cloud.h)
          }
          // one soft band crossing the grid. Reduced motion leaves the cells as they were painted.
          if (opts.drift && weather > 0.05) {
            const span = 180
            const shift = ((t * 22) % (w + span * 2)) - span
            ctx.save()
            ctx.beginPath()
            ctx.rect(cloud.x, y, cloud.w, cloud.h)
            ctx.clip()
            ctx.globalCompositeOperation = 'source-atop'
            ctx.globalAlpha = weather * l.alpha * 0.45
            const sheen = ctx.createLinearGradient(shift, y, shift + span, y)
            sheen.addColorStop(0, `rgba(${lr},${lg},${lb},0)`)
            sheen.addColorStop(0.5, `rgba(${lr},${lg},${lb},0.18)`)
            sheen.addColorStop(1, `rgba(${lr},${lg},${lb},0)`)
            ctx.fillStyle = sheen
            ctx.fillRect(cloud.x, y, cloud.w, cloud.h)
            ctx.restore()
          }
        }
      }
      ctx.restore()
      ctx.globalAlpha = 1
    },
    /** For tests: the clouds in view, lane and left edge. */
    get clouds() {
      return clouds.map(c => ({ lane: c.lane, x: c.x, w: c.w }))
    },
  }
}
