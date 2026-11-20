import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import type { MetricsRow, ProjectBranch } from '@odin/shared/api'
import BranchTree from './BranchTree.vue'
import ModelsPanel from './ModelsPanel.vue'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: '/', component: { template: '<div />' } },
    { path: '/s/:id', name: 'session', component: { template: '<div />' } },
  ],
})

const branch = (name: string, sessionIds: string[]): ProjectBranch => ({
  name,
  headSha: 'a1b2c3d4',
  ahead: 0,
  behind: 0,
  merged: false,
  lastCommitAt: '2026-11-19T00:00:00Z',
  worktreePath: null,
  current: false,
  sessionIds,
  pull: null,
})

it('folds a busy branch into two session chips and a +N chip', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
  const wrapper = mount(BranchTree, {
    global: { plugins: [router] },
    props: {
      branches: [branch('main', ids)],
      defaultBranch: 'main',
      repo: null,
      sessions: [],
      filter: 'all',
      worktreesOnly: false,
      density: 'comfortable',
    },
  })
  expect(wrapper.findAll('a.ov-tree__chip')).toHaveLength(2)
  expect(wrapper.find('.ov-tree__chip--more').text()).toBe('+28 sessions')
})

const row = (model: string, cost: number): MetricsRow =>
  ({
    key: { model },
    n: 1,
    total: { costUsd: cost, tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 } },
  }) as unknown as MetricsRow

it('keeps the Models card to five rows and folds the rest', async () => {
  const rows = Array.from({ length: 14 }, (_, i) => row(`model-${i}`, 14 - i))
  const wrapper = mount(ModelsPanel, {
    props: { models: { ok: true, value: rows } as never, harnesses: null, loading: false },
  })
  expect(wrapper.findAll('.ov-models__row')).toHaveLength(5)
  expect(wrapper.find('.ov-models__toggle').text()).toContain('9 more models')
  await wrapper.find('.ov-models__toggle').trigger('click')
  expect(wrapper.findAll('.ov-models__line')).toHaveLength(9)
})
