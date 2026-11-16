import type { ModelInfo } from '@odin/shared/api'
import { DEFAULT_PRICING, normaliseModel } from '@odin/shared/pricing'

/**
 * A model's price bucket for the picker's cost glyph: 1 to 4 by output price per million tokens, from the shipped
 * price list (the user's pricing.json isn't visible to the browser). Models with no price get none, so no glyph.
 * Static per model: it does not move with the effort level.
 *   1: up to $2   2: up to $15   3: up to $30   4: above
 */
export function costTier(model: Pick<ModelInfo, 'value' | 'resolved'>): 1 | 2 | 3 | 4 | undefined {
  const price = DEFAULT_PRICING[normaliseModel(model.resolved ?? model.value)]
  if (!price) return undefined
  return price.output <= 2 ? 1 : price.output <= 15 ? 2 : price.output <= 30 ? 3 : 4
}
