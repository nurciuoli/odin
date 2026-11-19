import { describe, expect, it } from 'vitest'
import { createFlock, flockSize, wingspan } from './murmuration'

describe('raven murmuration', () => {
  it('holds a loose party of ravens, more in a bigger sky, within bounds', () => {
    expect(flockSize(760, 280)).toBe(48)
    expect(flockSize(320, 220)).toBe(16)
    expect(flockSize(400, 280)).toBeGreaterThan(flockSize(320, 220))
  })

  it('beats three times, then glides with the wings open', () => {
    const samples = Array.from({ length: 200 }, (_, i) => wingspan(i / 200, 0, 1))
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(0.24)
    expect(Math.max(...samples)).toBeLessThanOrEqual(1)
    // the last two thirds of the cycle is a glide
    expect(samples.slice(80).every(v => v === 1)).toBe(true)
    // three beats: the wings close three times
    const closes = samples.filter((v, i) => i > 0 && v < 0.3 && samples[i - 1]! >= 0.3).length
    expect(closes).toBe(3)
  })

  it('flies two parties that stay in the sky at a raven pace', () => {
    const w = 760,
      h = 280
    const flock = createFlock(w, h)
    expect(new Set(flock.birds.map(b => b.party))).toEqual(new Set([0, 1]))
    for (let t = 0; t < 20; t += 1 / 30) flock.step(t, 1 / 30, { pointer: null, gather: 0 })
    for (const b of flock.birds) {
      expect(b.x).toBeGreaterThan(-20)
      expect(b.x).toBeLessThan(w + 20)
      expect(b.y).toBeGreaterThan(-20)
      expect(b.y).toBeLessThan(h + 20)
      const speed = Math.hypot(b.vx, b.vy)
      expect(speed).toBeGreaterThanOrEqual(33.9)
      expect(speed).toBeLessThanOrEqual(92.1)
    }
  })

  it('draws one closed silhouette per raven, accent ravens in their own pass', () => {
    const flock = createFlock(760, 280)
    const fills: string[] = []
    let shapes = 0
    const state = { fillStyle: '', globalAlpha: 1 }
    const ctx = Object.assign(state, {
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {
        shapes++
      },
      fill() {
        fills.push(state.fillStyle)
      },
    }) as unknown as CanvasRenderingContext2D
    flock.draw(ctx, 'grey', 'accent', 1.2)
    expect(shapes).toBe(flock.birds.length)
    expect(fills).toEqual(['grey', 'accent'])
  })
})
