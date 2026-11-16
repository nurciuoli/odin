import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDesktop, hasDesktop, openPath } from './desktop'

afterEach(() => {
  delete window.odinDesktop
})

describe('desktop bridge', () => {
  it('is absent in a browser', async () => {
    expect(hasDesktop()).toBe(false)
    expect(getDesktop()).toBeNull()
    expect(await openPath('/work/a', 'editor')).toBe(false)
  })

  it('passes the path and target to the shell', async () => {
    const open = vi.fn()
    window.odinDesktop = { platform: 'linux', openPath: open }
    expect(hasDesktop()).toBe(true)
    expect(await openPath('/work/a', 'terminal')).toBe(true)
    expect(open).toHaveBeenCalledWith('/work/a', 'terminal')
  })

  it('reports a refusal instead of throwing', async () => {
    window.odinDesktop = { platform: 'linux', openPath: () => Promise.reject(new Error('no')) }
    expect(await openPath('/elsewhere', 'files')).toBe(false)
  })
})
