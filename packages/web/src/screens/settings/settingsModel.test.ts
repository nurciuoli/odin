// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMockApi } from '@/api/mock'
import {
  emptyPriceRow,
  formFromSettings,
  pricingFromRows,
  settingsRequest,
  validatePricing,
} from './settingsModel'

const saved = () => createMockApi().getSettings()

describe('app settings model', () => {
  it('has nothing to save straight after loading', async () => {
    const s = await saved()
    expect(settingsRequest(formFromSettings(s), s)).toBeNull()
  })

  it('sends only changed defaults; an empty model clears it', async () => {
    const s = await saved()
    const f = formFromSettings(s)
    f.defaultWorktree = !f.defaultWorktree
    f.defaultPermissionMode = 'plan'
    expect(settingsRequest(f, s)).toEqual({
      settings: { defaultWorktree: true, defaultPermissionMode: 'plan' },
    })
    f.defaultModel = 'opus'
    expect(settingsRequest(f, s)!.settings!.defaultModel).toBe('opus')
  })

  it('sends the whole pricing table when a price changes', async () => {
    const s = await saved()
    const f = formFromSettings(s)
    f.pricing[0]!.output = '99'
    const req = settingsRequest(f, s)!
    expect(Object.keys(req.pricing!)).toHaveLength(Object.keys(s.pricing).length)
    expect(req.pricing![f.pricing[0]!.model]!.output).toBe(99)
    expect(req.settings).toBeUndefined()
  })

  it('validates price rows', () => {
    const row = { model: 'm', input: '1', output: '2', cacheRead: '0.1', cacheWrite: '3' }
    expect(validatePricing([row])).toEqual({})
    expect(validatePricing([emptyPriceRow()])[0]).toBe('Name the model.')
    expect(validatePricing([{ ...row, output: '-1' }])[0]).toContain('numbers')
    expect(validatePricing([{ ...row, input: '' }])[0]).toContain('numbers')
    expect(validatePricing([row, row])[1]).toContain('twice')
    expect(pricingFromRows([row])).toEqual({
      m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 3 },
    })
  })
})
