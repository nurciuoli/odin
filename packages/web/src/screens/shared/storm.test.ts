import { describe, expect, it } from 'vitest'
import { createStorm } from './storm'

const W = 1440
function run(storm: ReturnType<typeof createStorm>, seconds: number, active: boolean, from = 0) {
  for (let t = 0; t < seconds; t += 0.1) storm.step(from + t, 0.1, active)
}

describe('storm sky', () => {
  it('starts clear and sends clouds in from both sides when the weather starts', () => {
    const storm = createStorm(W, 400)
    expect(storm.clouds).toEqual([])
    run(storm, 1, true)
    const lanes = new Set(storm.clouds.map(c => c.lane))
    expect(lanes.size).toBe(2)
    for (const c of storm.clouds) {
      // each lane's first cloud has only just crossed its edge: from the left, or from the right
      if (c.lane === 1) expect(c.x + c.w).toBeLessThan(60)
      else expect(c.x).toBeGreaterThan(W - 60)
    }
  })

  it('keeps an endless stream across the whole width, in opposite directions', () => {
    const storm = createStorm(W, 400)
    run(storm, 40, true)
    const before = storm.clouds
    run(storm, 5, true, 40)
    const after = storm.clouds
    // far lane (0) moves left, near lane (1) moves right
    const far = before.find(c => c.lane === 0)!
    const nearBefore = before.find(c => c.lane === 1)!
    expect(after.find(c => c.lane === 0 && c.w === far.w && c.x < far.x)).toBeDefined()
    expect(
      after.find(c => c.lane === 1 && c.w === nearBefore.w && c.x > nearBefore.x),
    ).toBeDefined()
    // the lanes keep being fed: well past one crossing, cloud is still spread over the screen
    run(storm, 200, true, 45)
    const spread = storm.clouds.map(c => c.x + c.w / 2)
    expect(Math.min(...spread)).toBeLessThan(W * 0.25)
    expect(Math.max(...spread)).toBeGreaterThan(W * 0.75)
  })

  it('stops sending clouds when the weather ends and lets the rest drift out', () => {
    const storm = createStorm(W, 400)
    run(storm, 100, true)
    expect(storm.clouds.length).toBeGreaterThan(4)
    run(storm, 75, false, 100)
    // by now the sky has faded out; the last clouds are still on their way off
    expect(storm.gather).toBeLessThan(0.02)
    expect(storm.clouds.length).toBeGreaterThan(0)
    run(storm, 200, false, 175)
    expect(storm.clouds).toEqual([])
  })

  it('settles straight to a full sky, or a clear one', () => {
    const storm = createStorm(W, 400)
    storm.settle(true)
    expect(storm.gather).toBe(1)
    expect(storm.clouds.length).toBeGreaterThan(4)
    storm.settle(false)
    expect(storm.clouds).toEqual([])
  })
})
