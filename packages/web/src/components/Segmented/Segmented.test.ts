import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import Segmented from './Segmented.vue'

const options = [
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
  { value: '90', label: '90d', disabled: true },
  { value: 'all', label: 'All' },
]
const make = (value = '7') =>
  mount(Segmented, {
    props: {
      options,
      label: 'Range',
      modelValue: value,
      'onUpdate:modelValue': (v: string | undefined) => w.setProps({ modelValue: v }),
    },
    attachTo: document.body,
  })
let w: ReturnType<typeof make>

describe('IuSegmented', () => {
  it('is a labelled radiogroup with one tab stop on the selection', () => {
    w = make('30')
    expect(w.attributes('role')).toBe('radiogroup')
    expect(w.attributes('aria-label')).toBe('Range')
    const radios = w.findAll('[role=radio]')
    expect(radios.map(r => r.attributes('aria-checked'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ])
    expect(radios.map(r => r.attributes('tabindex'))).toEqual(['-1', '0', '-1', '-1'])
    w.unmount()
  })
  it('arrow keys move the selection, skip disabled options and wrap', async () => {
    w = make('30')
    await w.find('[aria-checked=true]').trigger('keydown', { key: 'ArrowRight' })
    expect(w.props('modelValue')).toBe('all')
    await w.find('[aria-checked=true]').trigger('keydown', { key: 'ArrowRight' })
    expect(w.props('modelValue')).toBe('7')
    await w.find('[aria-checked=true]').trigger('keydown', { key: 'End' })
    expect(w.props('modelValue')).toBe('all')
    w.unmount()
  })
  it('click selects', async () => {
    w = make()
    await w.findAll('[role=radio]')[1]!.trigger('click')
    expect(w.props('modelValue')).toBe('30')
    w.unmount()
  })
})
