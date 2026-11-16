// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { pickerExtras } from './effort'

describe('pickerExtras', () => {
  it('carries the price bucket and capitalised levels', () => {
    expect(
      pickerExtras({
        value: 'sonnet',
        displayName: 'Sonnet',
        description: '',
        resolved: 'claude-sonnet-5-5',
        effortLevels: ['low', 'max'],
      }),
    ).toEqual({
      cost: 2,
      effortLevels: [
        { id: 'low', label: 'Low' },
        { id: 'max', label: 'Max' },
      ],
    })
  })
  it('adds nothing for an unpriced model without levels', () => {
    expect(pickerExtras({ value: 'x', displayName: 'X', description: '', resolved: null })).toEqual(
      {},
    )
  })
})
