// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  buildMarkdown,
  entryFile,
  idError,
  parseMarkdown,
  slugify,
  skillFromSession,
  specProblems,
  starterFiles,
  type SessionSource,
} from './assetForm'

const session: SessionSource = {
  title: 'Fix the History filter',
  tags: ['fix'],
  model: 'opus',
  permissionMode: 'acceptEdits',
  agent: 'library:reviewer',
  workspace: { kind: 'worktree', path: '/tmp/w', branch: 'fix' },
  transcript: [
    { kind: 'assistant', id: 'a0', text: 'hi', model: null, at: null, parentToolUseId: null },
    { kind: 'user', id: 'u1', text: '  Fix {{x}} please  ', at: null, parentToolUseId: null },
    { kind: 'user', id: 'u2', text: 'second', at: null, parentToolUseId: null },
  ],
}

describe('markdown frontmatter', () => {
  it('round trips fields and body', () => {
    const text = buildMarkdown(
      [
        ['name', 'reviewer'],
        ['description', 'Reviews.'],
        ['tools', ''],
      ],
      'Body line.\n',
    )
    expect(text).toBe('---\nname: reviewer\ndescription: Reviews.\n---\n\nBody line.\n')
    expect(parseMarkdown(text)).toEqual({
      fields: { name: 'reviewer', description: 'Reviews.' },
      body: 'Body line.\n',
    })
  })
  it('treats text without frontmatter as body', () => {
    expect(parseMarkdown('just text')).toEqual({ fields: {}, body: 'just text' })
  })
})

describe('ids and starters', () => {
  it('validates ids', () => {
    expect(idError('good-id')).toBeNull()
    expect(idError('')).toMatch(/id/)
    expect(idError('Bad Id')).toMatch(/lowercase/)
    expect(idError('taken', ['taken'])).toMatch(/already/)
    expect(slugify('Fix the History filter!')).toBe('fix-the-history-filter')
  })
  it('names the entry file per kind', () => {
    expect(entryFile('agent', 'a')).toBe('a.md')
    expect(entryFile('instruction', 'global')).toBe('AGENTS.md')
    expect(entryFile('skill', 's')).toBe('SKILL.md')
  })
  it('starter files parse', () => {
    expect(Object.keys(starterFiles('skill', 's', 'S', ''))).toEqual(['SKILL.md'])
    const mcp = starterFiles('mcp', 'm', 'M', '')['m.json']!
    expect(JSON.parse(mcp).command).toBe('npx')
    const stdio = JSON.parse(
      starterFiles('mcp', 'f', 'F', '', { type: 'stdio', command: 'npx -y pkg' })['f.json']!,
    )
    expect([stdio.command, stdio.args]).toEqual(['npx', ['-y', 'pkg']])
    const remote = JSON.parse(
      starterFiles('mcp', 'r', 'R', '', { type: 'http', url: 'https://x.dev/mcp' })['r.json']!,
    )
    expect([remote.type, remote.url]).toEqual(['http', 'https://x.dev/mcp'])
    expect(starterFiles('instruction', 'global', '', '')['AGENTS.md']).toContain(
      'Project instructions',
    )
  })
})

describe('MCP validation', () => {
  it('an MCP spec needs its transport field', () => {
    expect(specProblems('mcp', { name: 'm', type: 'stdio' })).toHaveLength(1)
    expect(specProblems('mcp', { name: 'm', type: 'http', url: 'https://x' })).toEqual([])
  })
})

describe('from a session', () => {
  it('makes a skill from the first user message without saving launch settings', () => {
    const files = skillFromSession(session, 'fix-filter', 'Fix filter', 'About it')
    expect(Object.keys(files)).toEqual(['SKILL.md'])
    expect(parseMarkdown(files['SKILL.md']!).body).toBe('Fix {{x}} please\n')
    expect(files['SKILL.md']).not.toContain('model:')
  })
})
