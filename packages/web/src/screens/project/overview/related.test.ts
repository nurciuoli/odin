// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { firstSection, relatedProjects } from './related'

describe('relatedProjects', () => {
  it('counts the other projects of sessions, most frequent first', () => {
    const s = (projects: string[]) => ({ project: projects[0]!, projects })
    expect(
      relatedProjects('a', [s(['a', 'b']), s(['a', 'c', 'b']), s(['a']), s(['x', 'c'])]),
    ).toEqual([
      { name: 'b', count: 2 },
      { name: 'c', count: 1 },
    ])
  })
  it('falls back to the working project when projects[] is empty', () => {
    expect(relatedProjects('a', [{ project: 'a', projects: [] }])).toEqual([])
  })
})

describe('firstSection', () => {
  it('keeps the title, intro and first section', () => {
    const doc = '# Status\n\nIntro.\n\n## Now\n\nWorking.\n\n## Next\n\nLater.'
    expect(firstSection(doc)).toEqual({
      excerpt: '# Status\n\nIntro.\n\n## Now\n\nWorking.',
      more: true,
    })
  })
  it('returns the whole doc when it has one section', () => {
    expect(firstSection('## Only\n\ntext')).toEqual({ excerpt: '## Only\n\ntext', more: false })
  })
  it('without a title, cuts at the second heading', () => {
    expect(firstSection('Intro\n## A\nx\n## B\ny').excerpt).toBe('Intro\n## A\nx')
  })
})
