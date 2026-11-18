// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { LibraryAsset, McpOAuthStatus, SecretsResponse } from '@odin/shared/api'
import { mcpRows, needsAttention, oauthIds } from './mcpModel'

const asset = (
  id: string,
  meta: Record<string, unknown>,
  error: string | null = null,
): LibraryAsset => ({
  kind: 'mcp',
  id,
  name: id,
  description: '',
  version: 'v',
  updatedAt: '',
  files: [`${id}.json`],
  meta,
  error,
  enabled: true,
})
const status = (state: McpOAuthStatus['state']): McpOAuthStatus => ({
  id: 'x',
  state,
  issuer: null,
  scope: null,
  expiresAt: null,
})
const vault: SecretsResponse = {
  secrets: [{ name: 'TOKEN', createdAt: '', updatedAt: '', usedBy: ['gh'] }],
  missing: [{ name: 'KEY', usedBy: ['internal'] }],
}

describe('mcpRows', () => {
  const assets = [
    asset('local', { type: 'stdio', command: 'npx', args: ['server', '-y'] }),
    asset('docs', { type: 'http', url: 'https://x.test/mcp', oauth: {} }),
    asset('gh', { type: 'http', url: 'https://gh.test/mcp', headers: { A: '${secret:TOKEN}' } }),
    asset('internal', { type: 'http', url: 'https://i.test/mcp', headers: { K: '${secret:KEY}' } }),
    asset('open', { type: 'sse', url: 'https://o.test/sse' }),
    asset('broken', {}, 'bad spec'),
  ]
  const rows = mcpRows(assets, vault, { docs: status('needs-sign-in') })
  const by = (id: string) => rows.find(r => r.id === id)!

  it('describes how each server connects and signs in', () => {
    expect(by('local')).toMatchObject({
      transport: 'stdio',
      target: 'npx server -y',
      auth: { kind: 'local' },
    })
    expect(by('docs').auth).toEqual({ kind: 'oauth', status: status('needs-sign-in') })
    expect(by('gh').auth).toEqual({ kind: 'secrets', names: ['TOKEN'] })
    expect(by('internal')).toMatchObject({
      missing: ['KEY'],
      auth: { kind: 'secrets', names: ['KEY'] },
    })
    expect(by('open')).toMatchObject({ transport: 'sse', auth: { kind: 'none' } })
    expect(by('broken').auth).toEqual({ kind: 'error' })
  })

  it('shows an OAuth server as loading until its status arrives, and sorts by name', () => {
    expect(mcpRows(assets, vault, {}).find(r => r.id === 'docs')!.auth).toEqual({
      kind: 'oauth',
      status: 'loading',
    })
    expect(rows.map(r => r.name)).toEqual(['broken', 'docs', 'gh', 'internal', 'local', 'open'])
  })

  it('knows which servers need the person', () => {
    expect(rows.filter(needsAttention).map(r => r.id)).toEqual(['broken', 'docs', 'internal'])
    expect(
      needsAttention(
        mcpRows(assets, vault, { docs: status('connected') }).find(r => r.id === 'docs')!,
      ),
    ).toBe(false)
    expect(oauthIds(rows)).toEqual(['docs'])
  })
})
