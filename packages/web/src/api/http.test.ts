// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createHttpApi } from './http'
import { ApiRequestError } from './types'

function fakeFetch(res: { status?: number; body?: unknown }) {
  return vi.fn(async (_url: string, _init?: RequestInit) => {
    const status = res.status ?? 200
    return new Response(status === 204 ? null : JSON.stringify(res.body ?? {}), { status })
  })
}

describe('http api', () => {
  it('GETs and parses JSON', async () => {
    const f = fakeFetch({ body: [{ name: 'odin' }] })
    const api = createHttpApi({ fetch: f as unknown as typeof fetch })
    expect(await api.listProjects()).toEqual([{ name: 'odin' }])
    expect(f.mock.calls[0]![0]).toBe('/api/projects')
  })

  it('PATCHes settings with a JSON body and encodes the name', async () => {
    const f = fakeFetch({ body: { name: 'a b' } })
    const api = createHttpApi({ fetch: f as unknown as typeof fetch })
    await api.updateProjectSettings('a b', { title: 'T' })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/projects/a%20b/settings')
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe('{"title":"T"}')
  })

  it('returns undefined for 204', async () => {
    const api = createHttpApi({ fetch: fakeFetch({ status: 204 }) as unknown as typeof fetch })
    expect(await api.syncProject('x')).toBeUndefined()
  })

  it("throws ApiRequestError with the server's error text", async () => {
    const api = createHttpApi({
      fetch: fakeFetch({
        status: 409,
        body: { error: 'Project "x" already exists' },
      }) as unknown as typeof fetch,
    })
    const err = await api.getProject('x').catch(e => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect(err.status).toBe(409)
    expect(err.message).toBe('Project "x" already exists')
  })

  it('reports an unreachable server as status 0', async () => {
    const api = createHttpApi({
      fetch: (() => Promise.reject(new TypeError('failed to fetch'))) as unknown as typeof fetch,
    })
    const err = await api.listProjects().catch(e => e)
    expect(err).toBeInstanceOf(ApiRequestError)
    expect(err.status).toBe(0)
  })

  it('builds query strings for sessions and metrics', async () => {
    const f = fakeFetch({ body: [] })
    const api = createHttpApi({ fetch: f as unknown as typeof fetch })
    await api.listSessions({
      project: 'p',
      state: ['running', 'waiting'],
      archived: false,
      limit: 20,
    })
    await api.getMetrics({ groupBy: ['model', 'harness'], project: 'p' })
    expect(f.mock.calls.map(c => c[0])).toEqual([
      '/api/sessions?project=p&state=running%2Cwaiting&archived=false&limit=20',
      '/api/metrics?groupBy=model%2Charness&project=p',
    ])
  })

  it('sends the side-thread filters, fork options and promote', async () => {
    const f = fakeFetch({ body: {} })
    const api = createHttpApi({ fetch: f as unknown as typeof fetch })
    await api.listSessions({ parentId: 's1', aside: true })
    await api.listSessions({ aside: false })
    await api.forkSession('s1', {
      aside: true,
      prompt: { text: 'why?' },
      permissionMode: 'plan',
      model: 'm',
    })
    await api.updateSession('s1', { aside: false })
    expect(f.mock.calls.map(c => [c[0], c[1]?.method, c[1]?.body])).toEqual([
      ['/api/sessions?aside=true&parentId=s1', 'GET', undefined],
      ['/api/sessions?aside=false', 'GET', undefined],
      [
        '/api/sessions/s1/fork',
        'POST',
        '{"aside":true,"prompt":{"text":"why?"},"permissionMode":"plan","model":"m"}',
      ],
      ['/api/sessions/s1', 'PATCH', '{"aside":false}'],
    ])
  })

  it('previews and starts a handoff', async () => {
    const f = fakeFetch({ body: {} })
    const api = createHttpApi({ fetch: f as unknown as typeof fetch })
    await api.handoffPreview('s 1', 'codex')
    await api.handoffSession('s1', { harness: 'codex', brief: 'go', endSource: false })
    expect(f.mock.calls.map(c => [c[0], c[1]?.method, c[1]?.body])).toEqual([
      ['/api/sessions/s%201/handoff?harness=codex', 'GET', undefined],
      ['/api/sessions/s1/handoff', 'POST', '{"harness":"codex","brief":"go","endSource":false}'],
    ])
  })

  it('encodes session ids and permission request ids in paths', async () => {
    const f = fakeFetch({ status: 204 })
    const api = createHttpApi({ fetch: f as unknown as typeof fetch })
    await api.answerPermission('s/1', 'r 2', { behavior: 'allow', scope: 'once' })
    const [url, init] = f.mock.calls[0]!
    expect(url).toBe('/api/sessions/s%2F1/permissions/r%202')
    expect(init?.body).toBe('{"behavior":"allow","scope":"once"}')
  })
})
