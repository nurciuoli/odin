import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

const settle = async () => {
  for (let i = 0; i < 4; i++) await flushPromises()
}
import { createMockApi } from '@/api/mock'
import { mountProjectScreen } from '@/screens/shared/testSupport'
import { driftActions } from './driftModel'
import ProjectLibraryScreen from './ProjectLibraryScreen.vue'

const mounted: { unmount(): void }[] = []
afterEach(() => {
  mounted.splice(0).forEach(w => w.unmount())
  document.body.innerHTML = ''
})
async function mountTab() {
  const m = await mountProjectScreen(
    ProjectLibraryScreen,
    '/p/odin/library',
    createMockApi(),
    'odin',
  )
  mounted.push(m.wrapper)
  return m
}
const rowOf = (w: Awaited<ReturnType<typeof mountTab>>['wrapper'], text: string) =>
  w.findAll('li').find(li => li.text().includes(text))!
const buttonIn = (row: ReturnType<typeof rowOf>, label: string) =>
  row.findAll('button').find(b => b.text() === label)!

describe('driftActions', () => {
  it('offers per state, always with forget', () => {
    expect(driftActions('current').map(a => a.id)).toEqual(['forget'])
    expect(driftActions('update-available').map(a => a.id)).toEqual(['update', 'diff', 'forget'])
    expect(driftActions('modified').map(a => a.id)).toEqual(['diff', 'push', 'overwrite', 'forget'])
    expect(driftActions('missing').map(a => a.id)).toEqual(['update', 'forget'])
  })
})

describe('ProjectLibraryScreen', () => {
  it('lists installed assets with a drift label and sentence', async () => {
    const { wrapper } = await mountTab()
    await settle()
    expect(wrapper.text()).toContain('Update available')
    expect(wrapper.text()).toContain('Modified here')
    expect(wrapper.text()).toContain('The project copy matches the library.')
  })

  it('updates an asset that has a newer library version', async () => {
    const { api, wrapper } = await mountTab()
    await settle()
    const spy = vi.spyOn(api, 'install')
    await buttonIn(rowOf(wrapper, 'Update available'), 'Update').trigger('click')
    await settle()
    expect(spy).toHaveBeenCalledWith('odin', expect.objectContaining({ action: 'update' }))
    expect(wrapper.text()).not.toContain('Update available')
  })

  it('pushes a modified copy back only after confirming', async () => {
    const { api, wrapper } = await mountTab()
    await settle()
    const spy = vi.spyOn(api, 'install')
    await buttonIn(rowOf(wrapper, 'Modified here'), 'Push back to library').trigger('click')
    expect(spy).not.toHaveBeenCalled()
    const confirm = [...document.querySelectorAll('dialog footer button')].find(
      b => b.textContent?.trim() === 'Push back to library',
    ) as HTMLButtonElement
    confirm.click()
    await settle()
    expect(spy).toHaveBeenCalledWith('odin', expect.objectContaining({ action: 'push' }))
  })

  it('keeps the files and stops tracking on "Keep and stop tracking"', async () => {
    const { api, wrapper } = await mountTab()
    await settle()
    await buttonIn(rowOf(wrapper, 'Modified here'), 'Keep and stop tracking').trigger('click')
    await settle()
    expect(await api.listInstallations('odin')).toHaveLength(2)
  })

  it('shows the library against the project copy', async () => {
    const { wrapper } = await mountTab()
    await settle()
    await buttonIn(rowOf(wrapper, 'Modified here'), 'View diff').trigger('click')
    await settle()
    const dialog = document.querySelector('dialog')!
    expect(dialog.textContent).toContain('SKILL.md')
    expect(dialog.querySelector('.iu-code-diff, [class*="diff"]')).not.toBeNull()
  })

  it('installs from the library', async () => {
    const { api, wrapper } = await mountTab()
    await settle()
    const spy = vi.spyOn(api, 'install')
    await wrapper
      .findAll('button')
      .find(b => b.text().includes('Install from library'))!
      .trigger('click')
    await settle()
    const radio = document.querySelector('dialog input[type="radio"]') as HTMLInputElement
    expect(radio).not.toBeNull()
    radio.click()
    await settle()
    ;(
      [...document.querySelectorAll('dialog footer button')].find(
        b => b.textContent?.trim() === 'Install',
      ) as HTMLButtonElement
    ).click()
    await settle()
    expect(spy).toHaveBeenCalledWith('odin', expect.objectContaining({ action: 'install' }))
  })
})
