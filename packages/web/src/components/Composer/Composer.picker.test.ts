import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import IuComposer from './Composer.vue'

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
})

const levels = ['low', 'medium', 'high', 'xhigh'].map(id => ({
  id,
  label: id[0]!.toUpperCase() + id.slice(1),
}))
const models = [
  { id: 'opus', label: 'Opus', hint: 'Complex work', cost: 3 as const, effortLevels: levels },
  { id: 'haiku', label: 'Haiku', hint: 'Quick', cost: 1 as const },
  { id: 'plain', label: 'Plain' },
]

async function open(props: Record<string, unknown>) {
  wrapper = mount(IuComposer, { props, attachTo: document.body })
  await wrapper.find('button[aria-haspopup="menu"]').trigger('click')
  await flushPromises()
}

describe('IuComposer model and effort picker', () => {
  it('keeps the plain menu, with descriptions, when no model carries cost or effort', async () => {
    await open({ models: [{ id: 'a', label: 'A', hint: 'About A' }], modelId: 'a' })
    expect(wrapper!.find('[role="menuitemradio"]').text()).toContain('About A')
    expect(wrapper!.find('[role="radiogroup"]').exists()).toBe(false)
  })

  it('shows names and a labelled cost glyph, without descriptions', async () => {
    await open({ models, modelId: 'haiku' })
    const rows = wrapper!.findAll('[role="menuitemradio"]')
    expect(rows[0]!.text()).toBe('Opus')
    expect(rows[0]!.find('[role="img"]').attributes('aria-label')).toBe('Cost 3 of 4')
    expect(rows[0]!.findAll('.iu-composer__cost-dot--on')).toHaveLength(3)
    expect(rows[1]!.find('[role="img"]').attributes('aria-label')).toBe('Cost 1 of 4')
    expect(rows[2]!.find('[role="img"]').exists()).toBe(false)
  })

  it('shows the effort control only under a chosen model that has levels', async () => {
    await open({ models, modelId: 'haiku' })
    expect(wrapper!.find('[role="radiogroup"]').exists()).toBe(false)
    wrapper!.unmount()
    await open({ models, modelId: 'opus', effort: null })
    const radios = wrapper!.findAll('[role="radio"]')
    expect(radios.map(r => r.attributes('aria-label'))).toEqual(['Low', 'Medium', 'High', 'Xhigh'])
    expect(radios.every(r => r.attributes('aria-checked') === 'false')).toBe(true)
    expect(wrapper!.find('.iu-effort__label').text()).toBe('Auto')
    // it appeared on its own: focus stays on the menu, not the control
    expect(document.activeElement?.getAttribute('role')).toBe('menu')
  })

  it('picks a level, fills up to it, and shows the word on the chip in the level colour', async () => {
    await open({ models, modelId: 'opus', effort: 'medium' })
    const w = wrapper!
    expect(w.findAll('.iu-effort__segment--on')).toHaveLength(2)
    expect(w.find('.iu-effort').attributes('data-effort-tone')).toBe('ok')
    expect(w.find('.iu-composer__effort').text()).toBe('Medium')
    await w.find('[role="radio"][aria-label="High"]').trigger('click')
    expect(w.emitted('update:effort')!.at(-1)).toEqual(['high'])
    // choosing the current level again returns to Auto
    await w.find('[role="radio"][aria-label="High"]').trigger('click')
    expect(w.emitted('update:effort')!.at(-1)).toEqual([null])
  })

  it('moves the level with the arrow keys and leaves the menu alone', async () => {
    await open({ models, modelId: 'opus', effort: 'low' })
    const w = wrapper!
    await w.find('[role="radio"][aria-label="Low"]').trigger('keydown', { key: 'ArrowRight' })
    expect(w.emitted('update:effort')!.at(-1)).toEqual(['medium'])
    await w.find('[role="radio"][aria-label="Low"]').trigger('keydown', { key: 'ArrowLeft' })
    expect(w.emitted('update:effort')!.at(-1)).toEqual([null])
    expect(w.emitted('update:modelId')).toBeUndefined()
  })

  it('has no effort word on the chip for Auto or an unsupported model', async () => {
    wrapper = mount(IuComposer, { props: { models, modelId: 'opus', effort: null } })
    expect(wrapper.find('.iu-composer__effort').exists()).toBe(false)
    await wrapper.setProps({ modelId: 'haiku', effort: 'low' })
    expect(wrapper.find('.iu-composer__effort').exists()).toBe(false)
  })
})
