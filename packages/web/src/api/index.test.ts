// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chooseApi } from './index'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

describe('chooseApi', () => {
  it('uses the real API by default', () => {
    expect(chooseApi({ search: '', storage: memoryStorage() })).toBe('http')
  })

  it('uses the mock for ?mock and remembers it for the session', () => {
    const storage = memoryStorage()
    expect(chooseApi({ search: '?mock', storage })).toBe('mock')
    expect(chooseApi({ search: '', storage })).toBe('mock')
  })

  it('?mock=0 turns a sticky mock off', () => {
    const storage = memoryStorage({ 'odin.mock': '1' })
    expect(chooseApi({ search: '?mock=0', storage })).toBe('http')
    expect(chooseApi({ search: '', storage })).toBe('http')
  })

  it('uses the mock when the build sets VITE_MOCK=1', () => {
    expect(chooseApi({ search: '', env: '1', storage: memoryStorage() })).toBe('mock')
    expect(chooseApi({ search: '', env: '0', storage: memoryStorage() })).toBe('http')
  })

  it('still works when storage throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }
    expect(chooseApi({ search: '?mock', storage: broken })).toBe('mock')
    expect(chooseApi({ search: '', storage: broken })).toBe('http')
    expect(chooseApi({ search: '?mock', storage: null })).toBe('mock')
  })
})
