// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { costTier } from './costTier'

describe('costTier', () => {
  it('buckets the shipped prices by output price', () => {
    expect(costTier({ value: 'haiku', resolved: 'claude-haiku-5-5' })).toBe(1)
    expect(costTier({ value: 'sonnet', resolved: 'claude-sonnet-5-5' })).toBe(2)
    expect(costTier({ value: 'opus', resolved: 'claude-opus-5-5' })).toBe(3)
    expect(costTier({ value: 'fable', resolved: 'claude-fable-5-1' })).toBe(4)
  })
  it('prefers the resolved id, strips provider and context suffix, falls back to the value', () => {
    expect(costTier({ value: 'default', resolved: 'anthropic/claude-opus-5-5[1m]' })).toBe(3)
    expect(costTier({ value: 'claude-sonnet-5-5', resolved: null })).toBe(2)
  })
  it('has no tier for an unpriced model', () => {
    expect(costTier({ value: 'grok-4.7', resolved: 'grok-4.7' })).toBeUndefined()
    expect(costTier({ value: 'default', resolved: null })).toBeUndefined()
  })
})
