// Flocking motion adapted from the supplied empty-chat visual. Coordinates are CSS pixels.
interface Bird {
  x: number
  y: number
  vx: number
  vy: number
  nx: number
  ny: number
  hot: boolean
}
export interface FlockInput {
  pointer: { x: number; y: number } | null
  /** 0..1 how far the storm clouds have come in: the flock settles lower and tighter beneath them */
  gather: number
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

export function createFlock(w: number, h: number) {
  let seed = 23
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const birds: Bird[] = Array.from(
    { length: clamp(Math.round((w * h) / 950), 50, 210) },
    (_, i) => {
      const a = random() * Math.PI * 2
      return {
        x: w * (0.3 + random() * 0.4),
        y: h * (0.3 + random() * 0.4),
        vx: Math.cos(a) * 70,
        vy: Math.sin(a) * 70,
        nx: 0,
        ny: 0,
        hot: i % 31 === 7,
      }
    },
  )
  return {
    step(t: number, dt: number, s: FlockInput) {
      const f = Math.min(dt * 60, 3)
      const tx = w / 2 + w * (0.33 - 0.12 * s.gather) * Math.sin(t * 0.23)
      const ty = h * (0.5 + 0.12 * s.gather) + h * (0.24 - 0.08 * s.gather) * Math.sin(t * 0.41 + 1)
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
          const dx = o.x - b.x,
            dy = o.y - b.y,
            d2 = dx * dx + dy * dy
          if (d2 < 34 * 34 && o !== b) {
            n++
            cx += o.x
            cy += o.y
            ax += o.vx
            ay += o.vy
            if (d2 < 11 * 11) {
              const d = Math.sqrt(d2) + 0.01
              sx -= dx / d
              sy -= dy / d
            }
          }
        }
        let fx = (tx - b.x) * pull,
          fy = (ty - b.y) * pull
        if (n) {
          fx += (cx / n - b.x) * 0.02 + (ax / n - b.vx) * 0.05 + sx * 2.2
          fy += (cy / n - b.y) * 0.02 + (ay / n - b.vy) * 0.05 + sy * 2.2
        }
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
        const k = clamp(speed, 46, 126) / speed
        b.vx = b.nx * k
        b.vy = b.ny * k
        b.x += b.vx * dt
        b.y += b.vy * dt
      }
    },
    draw(ctx: CanvasRenderingContext2D, text: string, accent: string) {
      ctx.lineWidth = 1.2
      ctx.lineCap = 'round'
      for (const hot of [false, true]) {
        ctx.strokeStyle = hot ? accent : text
        ctx.globalAlpha = hot ? 1 : 0.8
        ctx.beginPath()
        for (const b of birds) {
          if (b.hot !== hot) continue
          const speed = Math.hypot(b.vx, b.vy) || 1
          ctx.moveTo(b.x - (b.vx / speed) * 5, b.y - (b.vy / speed) * 5)
          ctx.lineTo(b.x, b.y)
        }
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    },
  }
}
