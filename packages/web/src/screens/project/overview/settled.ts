// A result that loaded or failed on its own, so one range fetch can feed several panels that fail separately.
import { ApiRequestError } from '@/api'
import type { LoadError } from '@/screens/shared/useResource'

export type Settled<T> = { ok: true; value: T } | { ok: false; error: LoadError }

export async function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await p }
  } catch (e) {
    return {
      ok: false,
      error: {
        status: e instanceof ApiRequestError ? e.status : 0,
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}
