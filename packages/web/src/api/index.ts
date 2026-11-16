// useApi(): the one way screens reach data. The app picks the implementation once, at startup (`resolveApi`),
// and provides it; tests provide their own.
import { inject, type App, type InjectionKey } from 'vue'
import { createHttpApi } from './http'
import type { Api } from './types'
import { createMockApi } from './mock'
import { fakeDesktop } from '@/app/desktop'

export { ApiRequestError, type Api } from './types'

const STICKY_KEY = 'odin.mock'

export interface ApiChoice {
  /** The page's `location.search`. */
  search: string
  /** `import.meta.env.VITE_MOCK`. */
  env?: string
  /** sessionStorage, or anything shaped like it. Optional: private windows can refuse it. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

/**
 * Mock when the URL has `?mock` (sticky for the session, so navigating away from the query keeps it; `?mock=0`
 * turns it off again) or when the build sets VITE_MOCK=1. Otherwise the real API.
 */
export function chooseApi({ search, env, storage }: ApiChoice): 'mock' | 'http' {
  const params = new URLSearchParams(search)
  const safely = <T>(fn: () => T): T | undefined => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }
  if (params.has('mock')) {
    const off = ['0', 'false', 'off'].includes(params.get('mock') ?? '')
    if (off) safely(() => storage?.removeItem(STICKY_KEY))
    else safely(() => storage?.setItem(STICKY_KEY, '1'))
    return off ? (env === '1' ? 'mock' : 'http') : 'mock'
  }
  if (env === '1') return 'mock'
  return safely(() => storage?.getItem(STICKY_KEY)) === '1' ? 'mock' : 'http'
}

export function resolveApi(): { api: Api; kind: 'mock' | 'http' } {
  let storage: ApiChoice['storage'] = null
  try {
    storage = window.sessionStorage
  } catch {
    // blocked storage: mock mode just isn't sticky
  }
  const kind = chooseApi({
    search: window.location.search,
    env: import.meta.env.VITE_MOCK,
    storage,
  })
  if (kind === 'mock' && !window.odinDesktop) {
    const desktop = new URLSearchParams(window.location.search).get('desktop')
    if (desktop !== null) window.odinDesktop = fakeDesktop({ taken: desktop === 'taken' })
  }
  return { api: kind === 'mock' ? createMockApi({ latency: 60 }) : createHttpApi(), kind }
}

export const API_KEY: InjectionKey<Api> = Symbol('odin-api')
const MOCK_KEY: InjectionKey<boolean> = Symbol('odin-mock')

export function provideApi(app: App, api: Api, kind: 'mock' | 'http' = 'http') {
  app.provide(API_KEY, api)
  app.provide(MOCK_KEY, kind === 'mock')
}

export function useApi(): Api {
  const api = inject(API_KEY, null)
  if (!api) throw new Error('useApi() needs provideApi() at app startup')
  return api
}

/** True when the app is running on fixtures, so the shell can say so. */
export function useIsMock(): boolean {
  return inject(MOCK_KEY, false)
}
