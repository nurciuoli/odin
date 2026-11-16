// @vitest-environment node
import { expect, it } from 'vitest'
import type { ProjectSummary } from '@odin/shared/api'
import { openPullCounts, sortProjects } from './projectsIndex'

const p = (
  name: string,
  activity: number[],
  updatedAt = '2026-01-01',
  repo: string | null = null,
) =>
  ({
    name,
    title: name.toUpperCase(),
    description: '',
    repo,
    activity,
    updatedAt,
  }) as ProjectSummary

it('sorts by recent activity, then last update', () => {
  const out = sortProjects([p('a', [1]), p('b', [2, 3]), p('c', [1], '2026-02-01')])
  expect(out.map(x => x.name)).toEqual(['b', 'c', 'a'])
})

it('filters on name, title and repo', () => {
  const list = [p('alpha', []), p('beta', [], '2026-01-01', 'org/gamma')]
  expect(sortProjects(list, 'GAM').map(x => x.name)).toEqual(['beta'])
  expect(sortProjects(list, 'alp').map(x => x.name)).toEqual(['alpha'])
})

it('counts distinct open PRs per project', () => {
  const pull = (number: number, state: 'open' | 'closed') => ({
    number,
    url: '',
    state,
    merged: false,
  })
  const counts = openPullCounts([
    { project: 'a', pull: pull(1, 'open') },
    { project: 'a', pull: pull(1, 'open') },
    { project: 'a', pull: pull(2, 'closed') },
    { project: 'b', pull: null },
  ])
  expect([...counts]).toEqual([['a', 1]])
})
