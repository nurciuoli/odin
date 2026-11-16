// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { modelMenu } from './modelMenu'

describe('model menu', () => {
  it('keeps current families and defaults up front, with older releases checked in More models', () => {
    const menu = modelMenu(
      [
        { id: '', label: 'Default model' },
        { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
        { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
        { id: 'gpt-6-sol', label: 'GPT-6-Sol' },
        { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
        { id: 'custom', label: 'Custom model' },
      ],
      'gpt-6-sol',
    )
    expect(menu.map(m => 'id' in m && m.id)).toEqual([
      '',
      'gpt-6.1-sol',
      'gpt-6-astra',
      'custom',
      '__more-models',
    ])
    const more = menu.at(-1)!
    expect('items' in more && more.items).toEqual([
      expect.objectContaining({ id: 'gpt-6-sol', checked: true }),
      expect.objectContaining({ id: 'gpt-5.6-sol', checked: false }),
    ])
  })

  it('compares Claude releases per family and respects legacy catalog descriptions', () => {
    const menu = modelMenu([
      { id: 'sonnet', label: 'Sonnet 5.5' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'haiku', label: 'Haiku 4.5' },
      { id: 'old-custom', label: 'Other', hint: 'Previous generation model' },
    ])
    expect(menu.map(m => 'id' in m && m.id)).toEqual(['sonnet', 'haiku', '__more-models'])
  })

  it('does not add an empty submenu or remove custom choices', () => {
    expect(modelMenu([{ id: 'local', label: 'Local' }])).toHaveLength(1)
    expect(modelMenu([])).toEqual([])
  })
})
