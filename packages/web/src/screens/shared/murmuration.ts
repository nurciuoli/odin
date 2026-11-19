// Flocking motion adapted from the supplied empty-chat visual, flown by ravens: two loose parties that wander apart,
// cross and mingle. Coordinates are CSS pixels.
interface Bird {
  x: number
  y: number
  vx: number
  vy: number
  nx: number
  ny: number
  hot: boolean
  /** which party the raven keeps company with */
  party: 0 | 1
  /** where this raven is in its own wingbeat cycle, 0..1, and how fast that cycle runs */
  phase: number
  rate: number
}
export interface FlockInput {
  pointer: { x: number; y: number } | null
  /** 0..1 how far the storm clouds have come in: the flock settles lower and tighter beneath them */
  gather: number
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

// Ravens keep more room than starlings: they see their party out to NEAR and give each other SEP.
const NEAR = 54
const SEP = 24
const MIN_SPEED = 34
const MAX_SPEED = 92
/** silhouette scale: a raven is about 15px across the wings */
const SIZE = 1.6

/** How many ravens a sky of this size holds. */
export function flockSize(w: number, h: number) {
  return clamp(Math.round((w * h) / 4400), 16, 48)
}

/** How open the wings are, 0.24..1, at time `t`: three soft beats, then a long glide. */
export function wingspan(t: number, phase: number, rate: number) {
  const c = (((t * rate + phase) % 1) + 1) % 1
  const beat = c < 0.36 ? Math.cos((c / 0.36) * Math.PI * 6) : 1
  return 0.62 + 0.38 * beat
}

export function createFlock(w: number, h: number) {
  let seed = 23
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const birds: Bird[] = Array.from({ length: flockSize(w, h) }, (_, i) => {
    const a = random() * Math.PI * 2
    const party = (i % 2) as 0 | 1
    return {
      x: w * (party ? 0.55 : 0.25) + w * 0.2 * random(),
      y: h * (0.3 + random() * 0.4),
      vx: Math.cos(a) * 60,
      vy: Math.sin(a) * 60,
      nx: 0,
      ny: 0,
      hot: i % 9 === 4,
      party,
      phase: random(),
      rate: 0.32 + random() * 0.16,
    }
  })
  return {
    birds: birds as readonly Readonly<Bird>[],
    step(t: number, dt: number, s: FlockInput) {
      const f = Math.min(dt * 60, 3)
      // each party chases its own slow figure across the sky, so they drift apart and back through each other
      const targets = [
        [
          w / 2 + w * (0.33 - 0.12 * s.gather) * Math.sin(t * 0.23),
          h * (0.5 + 0.12 * s.gather) + h * (0.24 - 0.08 * s.gather) * Math.sin(t * 0.41 + 1),
        ],
        [
          w / 2 + w * (0.3 - 0.1 * s.gather) * Math.sin(t * 0.17 + 2.6),
          h * (0.5 + 0.12 * s.gather) + h * (0.22 - 0.08 * s.gather) * Math.sin(t * 0.37 + 4),
        ],
      ]
      const pull = 0.006
      for (const b of birds) {
        let cx = 0,
          cy = 0,
          ax = 0,
          ay = 0,
          sx = 0,
          sy = 0,
          n = 0
        for (const o of birds) {
          if (o === b) continue
          const dx = o.x - b.x,
            dy = o.y - b.y,
            d2 = dx * dx + dy * dy
          // everyone keeps their distance; only a raven's own party pulls it along
          if (d2 < SEP * SEP) {
            const d = Math.sqrt(d2) + 0.01
            sx -= dx / d
            sy -= dy / d
          }
          if (d2 < NEAR * NEAR && o.party === b.party) {
            n++
            cx += o.x
            cy += o.y
            ax += o.vx
            ay += o.vy
          }
        }
        const [tx, ty] = targets[b.party]!
        let fx = (tx - b.x) * pull + sx * 2.2,
          fy = (ty - b.y) * pull + sy * 2.2
        if (n) {
          fx += (cx / n - b.x) * 0.02 + (ax / n - b.vx) * 0.05
          fy += (cy / n - b.y) * 0.02 + (ay / n - b.vy) * 0.05
        }
        // a little wander of its own, so a party never locks into a lattice
        const wa = t * (0.5 + b.rate) + b.phase * Math.PI * 2
        fx += Math.cos(wa) * 1.4
        fy += Math.sin(wa * 1.3) * 1.4
        if (s.pointer) {
          const dx = b.x - s.pointer.x,
            dy = b.y - s.pointer.y,
            d = Math.hypot(dx, dy)
          if (d < 84) {
            const k = ((1 - d / 84) * 10) / (d + 1)
            fx += dx * k
            fy += dy * k
          }
        }
        if (b.x < 22) fx += (22 - b.x) * 0.3
        if (b.x > w - 22) fx -= (b.x - w + 22) * 0.3
        const ceiling = 14 + s.gather * h * 0.42
        if (b.y < ceiling) fy += (ceiling - b.y) * 0.3
        if (b.y > h - 14) fy -= (b.y - h + 14) * 0.3
        b.nx = b.vx + fx * f
        b.ny = b.vy + fy * f
      }
      for (const b of birds) {
        const speed = Math.hypot(b.nx, b.ny) || 1
        const k = clamp(speed, MIN_SPEED, MAX_SPEED) / speed
        b.vx = b.nx * k
        b.vy = b.ny * k
        b.x += b.vx * dt
        b.y += b.vy * dt
      }
    },
    /** `t` drives the wingbeats; a still frame (reduced motion) passes a fixed time and every raven glides. */
    draw(ctx: CanvasRenderingContext2D, text: string, accent: string, t = 0, still = false) {
      for (const hot of [false, true]) {
        ctx.fillStyle = hot ? accent : text
        ctx.globalAlpha = hot ? 1 : 0.85
        ctx.beginPath()
        for (const b of birds) {
          if (b.hot === hot) raven(ctx, b, still ? 1 : wingspan(t, b.phase, b.rate))
        }
        ctx.fill()
      }
      ctx.globalAlpha = 1
    },
  }
}

/** One raven seen from below, facing its heading: head and bill, fingered wings, wedge tail. Adds to the current path. */
function raven(ctx: CanvasRenderingContext2D, b: Bird, open: number) {
  const speed = Math.hypot(b.vx, b.vy) || 1
  const cx = b.vx / speed,
    cy = b.vy / speed
  const s = SIZE,
    span = open * s,
    // as the wings lift they also sweep back a touch
    sweep = ((1 - open) / 0.76) * 0.5 * s
  // u runs along the heading, v across it
  const P = (u: number, v: number): [number, number] => [
    b.x + u * cx - v * cy,
    b.y + u * cy + v * cx,
  ]
  const wing = (m: number): [number, number][] => [
    P(1.1 * s, 0.6 * m * s),
    P(0.7 * s + sweep * 0.4, 2.4 * m * span),
    P(-0.2 * s + sweep, 4.7 * m * span),
    P(-0.9 * s + sweep, 4.5 * m * span),
    P(-1.0 * s + sweep * 0.8, 4.1 * m * span),
    P(-1.5 * s + sweep * 0.6, 3.6 * m * span),
    P(-1.6 * s + sweep * 0.3, 2.2 * m * span),
    P(-1.3 * s, 0.75 * m * s),
    P(-2.0 * s, 0.6 * m * s),
    P(-3.1 * s, 0.95 * m * s),
  ]
  const pts = [
    P(2.9 * s, 0),
    P(2.0 * s, 0.45 * s),
    ...wing(1),
    P(-3.5 * s, 0),
    ...wing(-1).reverse(),
    P(2.0 * s, -0.45 * s),
  ]
  ctx.moveTo(pts[0]![0], pts[0]![1])
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0], pts[i]![1])
  ctx.closePath()
}
