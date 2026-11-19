import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { useFlagged } from './useFlagged'

describe('useFlagged', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('flags a key and clears it after the delay', () => {
    let api!: ReturnType<typeof useFlagged<string>>
    mount(
      defineComponent({
        setup() {
          api = useFlagged<string>(1000)
          return () => h('div')
        },
      }),
    )
    api.flag('a')
    expect(api.flagged.value.has('a')).toBe(true)
    vi.advanceTimersByTime(999)
    expect(api.flagged.value.has('a')).toBe(true)
    vi.advanceTimersByTime(2)
    expect(api.flagged.value.has('a')).toBe(false)
  })
})
