// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentContextItem, McpOAuthStatus, ProjectAgentContext } from '@odin/shared/api'
import { mcpRows, type McpRow } from '@/screens/mcp/mcpModel'
import { activeItems, mcpGroup, skillGroup } from './runtimeConfig'

function item(
  over: Partial<AgentContextItem> & Pick<AgentContextItem, 'kind' | 'id'>,
): AgentContextItem {
  return {
    name: over.id,
    description: '',
    origin: 'project',
    path: null,
    overridden: false,
    enabled: true,
    libraryEnabled: true,
    error: null,
    ...over,
  }
}

const empty: ProjectAgentContext = { global: [], project: [] }

describe('activeItems', () => {
  it('keeps enabled project and global items, and lets a project file replace a global', () => {
    const context: ProjectAgentContext = {
      project: [item({ kind: 'skill', id: 'ship', name: 'Ship' })],
      global: [
        item({ kind: 'skill', id: 'ship', name: 'Ship', origin: 'library', overridden: true }),
        item({ kind: 'skill', id: 'notes', name: 'Notes', origin: 'library' }),
        item({
          kind: 'skill',
          id: 'off',
          name: 'Off',
          origin: 'library',
          enabled: false,
        }),
        item({ kind: 'mcp', id: 'odin', name: 'odin', origin: 'library' }),
      ],
    }
    expect(activeItems(context, 'skill').map(row => row.id)).toEqual(['notes', 'ship'])
    expect(activeItems(context, 'mcp').map(row => row.id)).toEqual(['odin'])
  })
})

describe('mcpGroup', () => {
  const docs = {
    kind: 'mcp' as const,
    id: 'docs',
    name: 'docs',
    description: '',
    version: 'v',
    updatedAt: '',
    files: ['docs.json'],
    meta: { type: 'http', url: 'https://mcp.example.com/docs', oauth: { scope: 'read' } },
    error: null,
    enabled: true,
  }
  const local = {
    ...docs,
    id: 'playwright',
    name: 'playwright',
    files: ['playwright.json'],
    meta: { type: 'stdio', command: 'npx', args: ['mcp'] },
  }

  function rows(
    oauth: Record<string, 'loading' | { state: 'connected' | 'needs-sign-in' }>,
  ): McpRow[] {
    const status: Record<string, McpOAuthStatus | 'unknown'> = {}
    for (const [id, value] of Object.entries(oauth)) {
      if (value === 'loading') continue
      status[id] = { id, state: value.state, issuer: null, scope: null, expiresAt: null }
    }
    return mcpRows([docs, local], { secrets: [], missing: [] }, status)
  }

  it('stays muted while sign-in is still being checked, then warns when one server needs it', () => {
    const items = [
      item({ kind: 'mcp', id: 'docs', name: 'docs' }),
      item({ kind: 'mcp', id: 'playwright', name: 'playwright' }),
    ]
    const pending = mcpGroup(items, rows({ docs: 'loading' }), null)
    expect(pending.health).toBe('muted')
    expect(pending.summary).toBe('2 configured')

    const warned = mcpGroup(items, rows({ docs: { state: 'needs-sign-in' } }), null)
    expect(warned.health).toBe('warn')
    expect(warned.summary).toBe('2 configured · needs sign-in')
    expect(warned.entries.find(entry => entry.id === 'playwright')).toMatchObject({
      detail: 'connected',
      ok: true,
    })
  })

  it('is green when every configured server is connected, and adds a catalog server', () => {
    const group = mcpGroup(
      [item({ kind: 'mcp', id: 'docs', name: 'docs' })],
      rows({ docs: { state: 'connected' } }),
      [{ name: 'odin', status: 'connected' }],
    )
    expect(group.health).toBe('ok')
    expect(group.summary).toBe('2 configured · all connected')
    expect(group.entries.map(entry => entry.name)).toEqual(['docs', 'odin'])
  })

  it('lets a failing runtime status override a connected sign-in', () => {
    const group = mcpGroup(
      [item({ kind: 'mcp', id: 'docs', name: 'docs' })],
      rows({ docs: { state: 'connected' } }),
      [{ name: 'docs', status: 'needs_auth' }],
    )
    expect(group.health).toBe('warn')
    expect(group.entries[0]).toMatchObject({ detail: 'needs auth', ok: false })
  })

  it('counts nothing as a muted zero', () => {
    expect(mcpGroup([], [], null)).toMatchObject({ health: 'muted', summary: 'None configured' })
    expect(activeItems(empty, 'mcp')).toEqual([])
  })
})

describe('skillGroup', () => {
  it('lists configured skills and treats an error as the warning', () => {
    const group = skillGroup(
      [
        item({ kind: 'skill', id: 'ship', name: 'Ship', description: 'Ship the project.' }),
        item({ kind: 'skill', id: 'bad', name: 'Bad', error: 'broken' }),
      ],
      [{ name: 'review', description: 'Review the branch' }],
    )
    expect(group.health).toBe('warn')
    expect(group.summary).toBe('3 set up · 1 error')
    expect(group.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Bad', detail: 'error', ok: false }),
        expect.objectContaining({ name: 'review', detail: 'Review the branch', ok: true }),
        expect.objectContaining({ name: 'Ship', detail: 'Ship the project.', ok: true }),
      ]),
    )
  })

  it('is green when every skill is set up', () => {
    const group = skillGroup(
      [item({ kind: 'skill', id: 'ship', name: 'Ship', description: 'Ship it' })],
      null,
    )
    expect(group.health).toBe('ok')
    expect(group.summary).toBe('1 set up')
  })
})
