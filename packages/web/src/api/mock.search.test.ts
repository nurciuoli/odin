// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createMockApi, fuzzyMatchPaths } from './mock'
import { FIXTURE_SESSION_IDS } from './fixtures'
import { ApiRequestError } from './types'

describe('mock file search', () => {
  it('fuzzy-matches fixture paths, directories included', async () => {
    const api = createMockApi()
    const r = await api.searchSessionFiles(FIXTURE_SESSION_IDS.idle, 'exmp')
    expect(r.matches).toEqual([{ path: 'src/example.ts', kind: 'file' }])
    const dirs = await api.searchSessionFiles(FIXTURE_SESSION_IDS.idle, 'dat')
    expect(dirs.matches[0]).toEqual({ path: 'data', kind: 'directory' })
    const all = await api.searchSessionFiles(FIXTURE_SESSION_IDS.idle, '')
    expect(all.matches.length).toBeGreaterThan(3)
  })

  it('searches a project and rejects unknown ones', async () => {
    const api = createMockApi()
    const project = (await api.listProjects())[0]!.name
    expect((await api.searchProjectFiles(project, 'readme')).matches[0]?.path).toBe('README.md')
    await expect(api.searchProjectFiles('nope-nope', 'x')).rejects.toBeInstanceOf(ApiRequestError)
  })

  it('ranks basename prefixes first', () => {
    const paths = [
      { path: 'docs/a-readme.md', kind: 'file' as const },
      { path: 'README.md', kind: 'file' as const },
    ]
    expect(fuzzyMatchPaths(paths, 'read').map(m => m.path)).toEqual([
      'README.md',
      'docs/a-readme.md',
    ])
  })

  it('gives slash commands their full shape, with choices on /review', async () => {
    const api = createMockApi()
    const d = await api.getSession(FIXTURE_SESSION_IDS.idle)
    const review = d.slashCommands.find(c => c.name === 'review')
    expect(review?.choices?.length).toBeGreaterThan(1)
    expect(d.slashCommands.every(c => typeof c.description === 'string')).toBe(true)
  })
})
