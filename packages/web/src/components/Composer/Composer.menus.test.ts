import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import IuComposer from './Composer.vue'
import type { ComposerCommand } from '@/components/Chat/types'

let wrapper: VueWrapper | undefined
afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
})

const review: ComposerCommand = {
  id: 'review',
  name: 'review',
  description: 'Review code changes',
  group: 'Built-in',
  choices: [
    { label: 'Uncommitted changes', insert: '' },
    { label: 'Against a base branch', insert: 'branch ', hint: '<branch>' },
  ],
}
const clear: ComposerCommand = {
  id: 'clear',
  name: 'clear',
  aliases: ['reset'],
  argumentHint: '',
  group: 'Odin',
}

async function type(text: string) {
  const ta = wrapper!.find('textarea')
  const el = ta.element as HTMLTextAreaElement
  await ta.setValue(text)
  el.setSelectionRange(text.length, text.length)
  await ta.trigger('keyup')
}
const key = (k: string) => wrapper!.find('textarea').trigger('keydown', { key: k })

describe('IuComposer menus', () => {
  it('matches aliases and shows group labels and descriptions', async () => {
    wrapper = mount(IuComposer, { props: { commands: [clear, review] }, attachTo: document.body })
    await type('/res')
    const list = wrapper.find('[role="listbox"]')
    expect(list.text()).toContain('/clear')
    expect(list.find('[role="group"]').attributes('aria-label')).toBe('Odin')
    await type('/')
    expect(wrapper.find('[role="listbox"]').text()).toContain('Review code changes')
  })

  it('offers a command’s choices as a second step and shows the hint', async () => {
    wrapper = mount(IuComposer, { props: { commands: [review] }, attachTo: document.body })
    await type('/rev')
    await key('Enter')
    await flushPromises()
    const list = wrapper.find('[role="listbox"]')
    expect(list.attributes('aria-label')).toBe('Options for /review')
    await key('ArrowDown')
    await key('Enter')
    await flushPromises()
    expect((wrapper.find('textarea').element as HTMLTextAreaElement).value).toBe('/review branch ')
    expect(wrapper.find('.iu-composer__arg-hint').text()).toContain('<branch>')
  })

  it('searches files after @, debounced, and inserts the pick', async () => {
    vi.useFakeTimers()
    const searchFiles = vi.fn(async (q: string) => [
      { path: 'src', kind: 'directory' as const },
      { path: `src/${q}.ts`, kind: 'file' as const },
    ])
    wrapper = mount(IuComposer, { props: { searchFiles }, attachTo: document.body })
    await type('see @ex')
    expect(searchFiles).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(130)
    await flushPromises()
    expect(searchFiles).toHaveBeenCalledWith('ex')
    const ta = wrapper.find('textarea')
    expect(ta.attributes('role')).toBe('combobox')
    expect(ta.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[role="listbox"]').attributes('aria-label')).toBe('Files')
    await key('ArrowDown')
    await key('Tab')
    await flushPromises()
    expect((ta.element as HTMLTextAreaElement).value).toBe('see @src/ex.ts ')
  })

  it('closes the file menu on Escape', async () => {
    vi.useFakeTimers()
    const searchFiles = vi.fn(async () => [{ path: 'a.ts', kind: 'file' as const }])
    wrapper = mount(IuComposer, { props: { searchFiles }, attachTo: document.body })
    await type('@a')
    await vi.advanceTimersByTimeAsync(130)
    await flushPromises()
    expect(wrapper.find('[role="listbox"]').exists()).toBe(true)
    await key('Escape')
    expect(wrapper.find('[role="listbox"]').exists()).toBe(false)
  })
})
