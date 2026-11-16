// @vitest-environment node
import { expect, it } from 'vitest'
import { createMemoryHistory } from 'vue-router'
import { createAppRouter, PROJECT_SECTIONS } from './router'

it('has the project tabs in order', () => {
  expect(PROJECT_SECTIONS.map(s => s.id)).toEqual([
    'overview',
    'sessions',
    'files',
    'outputs',
    'resources',
    'settings',
  ])
})

it.each([
  ['/p/odin/work', 'project-overview', {}],
  ['/p/odin/backlog', 'project-overview', {}],
  ['/p/odin/roadmap', 'project-overview', {}],
  ['/p/odin/library', 'project-resources', {}],
  ['/p/odin/sessions', 'project-sessions', {}],
  ['/p/odin', 'project-overview', {}],
  ['/projects', 'projects', {}],
])('%s lands on %s', async (path, name, query) => {
  const router = createAppRouter(createMemoryHistory())
  await router.push(path)
  expect(router.currentRoute.value.name).toBe(name)
  expect(router.currentRoute.value.query).toEqual(query)
})
