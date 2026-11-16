// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toolVerb, toolVerbs } from './verbs'
import { toolMeta } from './summary'

describe('toolVerb', () => {
  it.each([
    ['Read', 'Reading', 'Read'],
    ['NotebookRead', 'Reading', 'Read'],
    ['Grep', 'Searching', 'Searched'],
    ['Glob', 'Searching', 'Searched'],
    ['Edit', 'Editing', 'Edited'],
    ['MultiEdit', 'Editing', 'Edited'],
    ['NotebookEdit', 'Editing', 'Edited'],
    ['Write', 'Writing', 'Wrote'],
    ['Bash', 'Running', 'Ran'],
    ['PowerShell', 'Running', 'Ran'],
    ['Terminal', 'Running', 'Ran'],
    ['WebFetch', 'Fetching', 'Fetched'],
    ['WebSearch', 'Searching the web', 'Searched the web'],
    ['Agent', 'Agent working', 'Agent finished'],
    ['Task', 'Agent working', 'Agent finished'],
  ])('%s: %s / %s', (name, live, done) => {
    expect(toolVerb(name, true)).toBe(live)
    expect(toolVerb(name, false)).toBe(done)
  })

  it('calls MCP tools and unknown tools by their title', () => {
    expect(toolVerbs('mcp__odin__post_artifact')).toEqual({
      live: 'Calling MCP',
      done: 'Called MCP',
    })
    expect(toolVerbs('Frobnicate')).toEqual({
      live: 'Calling Frobnicate',
      done: 'Called Frobnicate',
    })
    expect(toolVerb('read_file', true)).toBe('Reading')
    expect(toolVerb('search_replace', false)).toBe('Edited')
    expect(toolVerb('run_terminal_command', true)).toBe('Running')
    expect(toolVerb('list_dir', false)).toBe('Listed')
  })
})

describe('toolMeta', () => {
  const ok = (name: string, input: Record<string, unknown>, text?: string, truncated = false) => ({
    name,
    input,
    status: 'ok' as const,
    ...(text !== undefined ? { result: { text, truncated } } : {}),
  })

  it('counts changed lines for edits and writes', () => {
    expect(toolMeta(ok('Write', { content: 'a\nb\nc' }))).toBe('+3')
    expect(toolMeta(ok('Edit', { old_string: 'a\nb', new_string: 'a\nc\nd' }))).toBe('+2 −1')
    expect(toolMeta(ok('search_replace', { old_string: 'a\nb', new_string: 'a\nc\nd' }))).toBe(
      '+2 −1',
    )
    expect(toolMeta(ok('read_file', {}, 'one\ntwo'))).toBe('2 lines')
  })

  it('counts lines read, files found and matches', () => {
    expect(toolMeta(ok('Read', {}, 'one\ntwo\nthree'))).toBe('3 lines')
    expect(toolMeta(ok('Glob', {}, 'a.ts\nb.ts'))).toBe('2 files')
    expect(toolMeta(ok('Grep', { output_mode: 'content' }, 'a:1\nb:2'))).toBe('2 matches')
    expect(toolMeta(ok('Grep', {}, 'a.ts'))).toBe('1 file')
  })

  it('says nothing it cannot derive', () => {
    expect(toolMeta(ok('Read', {}, 'one\ntwo', true))).toBeUndefined()
    expect(toolMeta(ok('Grep', { output_mode: 'count' }, 'a.ts:3'))).toBeUndefined()
    expect(toolMeta(ok('Bash', { command: 'ls' }, 'x'))).toBeUndefined()
    expect(toolMeta({ ...ok('Read', {}, 'x'), status: 'failed' })).toBeUndefined()
  })
})
