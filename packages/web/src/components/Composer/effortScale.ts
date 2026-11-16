// How an effort level looks: its colour step on a four-step ramp (blue, green, amber, red), chosen by where the
// level sits among the model's own levels, so a model with 3 levels and one with 7 both end at red.
export type EffortTone = 'auto' | 'cool' | 'ok' | 'warm' | 'hot'

const RAMP: EffortTone[] = ['cool', 'ok', 'warm', 'hot']

/** `index` is the level's place in the model's list (-1 for Auto / none selected). */
export function effortTone(index: number, count: number): EffortTone {
  if (index < 0 || index >= count) return 'auto'
  if (count === 1) return 'ok'
  return RAMP[Math.round((index / (count - 1)) * (RAMP.length - 1))]!
}
