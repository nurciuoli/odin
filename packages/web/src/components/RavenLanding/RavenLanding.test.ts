import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { IuRavenLanding } from '.'

describe('IuRavenLanding', () => {
  it('rests by default and flies in only when landing', () => {
    expect(mount(IuRavenLanding).find('.iu-raven-land__fly').exists()).toBe(false)
    const w = mount(IuRavenLanding, { props: { landing: true } })
    expect(w.find('.iu-raven-land__fly').exists()).toBe(true)
    expect(w.get('.iu-raven-land').attributes('aria-hidden')).toBe('true')
  })
})
