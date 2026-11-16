import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuTerminalOutput } from './index'
import { stripAnsi } from './ansi'

afterEach(() => vi.unstubAllGlobals())

describe('IuTerminalOutput', () => {
  it('strips ANSI escapes', () => {
    expect(stripAnsi('\u001b[31mred\u001b[0m \u001b]0;title\u0007ok')).toBe('red ok')
    const w = mount(IuTerminalOutput, { props: { text: '\u001b[1mbold\u001b[22m' } })
    expect(w.find('pre').text()).toBe('bold')
  })
  it('shows the command, max height, error tone and truncated note', () => {
    const w = mount(IuTerminalOutput, {
      props: { text: 'x', command: 'ls', tone: 'error', maxHeight: '100px', truncated: true },
    })
    expect(w.text()).toContain('$ ls')
    expect(w.classes()).toContain('iu-terminal-output--error')
    expect(w.find('.iu-terminal-output__scroll').attributes('style')).toContain('100px')
    expect(w.text()).toContain('truncated')
  })
  it('copies the cleaned text', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const w = mount(IuTerminalOutput, { props: { text: '\u001b[31mhi\u001b[0m' } })
    await w.find('button').trigger('click')
    expect(writeText).toHaveBeenCalledWith('hi')
  })
})
