import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { IuComposer } from '.'

async function typed(props: Record<string, unknown> = {}) {
  const w = mount(IuComposer, { props, attachTo: document.body })
  await w.find('textarea').setValue('hello')
  return w
}

describe('IuComposer submit keys', () => {
  it('sends on Enter and keeps Mod+Enter a plain send without altSubmit', async () => {
    const w = await typed()
    await w.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(w.emitted('submit')?.[0]?.[0]).toMatchObject({ text: 'hello' })
    expect(w.emitted('submitAlt')).toBeUndefined()
    w.unmount()
  })

  it('emits submitAlt on Mod+Enter with altSubmit, and clears the draft like a send', async () => {
    const w = await typed({ altSubmit: true })
    await w.find('textarea').trigger('keydown', { key: 'Enter', metaKey: true })
    expect(w.emitted('submitAlt')?.[0]?.[0]).toMatchObject({ text: 'hello', attachments: [] })
    expect(w.emitted('submit')).toBeUndefined()
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('')

    await w.find('textarea').setValue('again')
    await w.find('textarea').trigger('keydown', { key: 'Enter', ctrlKey: true })
    expect(w.emitted('submitAlt')).toHaveLength(2)
    await w.find('textarea').setValue('plain')
    await w.find('textarea').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('submit')?.[0]?.[0]).toMatchObject({ text: 'plain' })
    w.unmount()
  })

  it('flags an Alt+Enter send and still ignores Shift+Enter', async () => {
    const w = await typed({ altSubmit: true })
    await w.find('textarea').trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(w.emitted('submit')).toBeUndefined()
    await w.find('textarea').trigger('keydown', { key: 'Enter', altKey: true })
    expect(w.emitted('submit')?.[0]?.[0]).toMatchObject({ text: 'hello', alt: true })
    w.unmount()
  })

  it('names the textarea Message unless given a label', () => {
    const plain = mount(IuComposer)
    expect(plain.find('textarea').attributes('aria-label')).toBe('Message')
    const named = mount(IuComposer, { props: { label: 'Follow-up message' } })
    expect(named.find('textarea').attributes('aria-label')).toBe('Follow-up message')
    plain.unmount()
    named.unmount()
  })
})
