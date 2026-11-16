import { mount, RouterLinkStub } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import BranchGraph from './BranchGraph.vue'
import { branchPath, branchSummary, extent } from './branchGraph'
import type { GraphBranch } from './types'

const branches: GraphBranch[] = [
  {
    name: 'item/26',
    forkAt: 0,
    length: 2,
    intent: 'positive',
    end: 'merged',
    marks: [{ at: 1, intent: 'positive', label: 'Remove Pi', to: '/s/1' }],
  },
  {
    name: 'keep-runner',
    forkAt: 1,
    length: 3,
    intent: 'warning',
    dashed: true,
    marks: [{ at: 3, intent: 'warning', label: 'Stale worktree' }],
  },
]

describe('branch graph model', () => {
  it('extends one step past a merge', () => {
    expect(extent(branches)).toBe(4)
    expect(extent([{ ...branches[0]!, end: 'none' }])).toBe(2)
  })
  it('paths rejoin the trunk only when merged', () => {
    expect(branchPath(branches[0]!, 1).match(/C/g)).toHaveLength(2)
    expect(branchPath(branches[1]!, 2).match(/C/g)).toHaveLength(1)
  })
  it('summaries say the end state in words', () => {
    expect(branchSummary(branches[0]!)).toBe('item/26 (merged)')
    expect(branchSummary(branches[1]!)).toBe('keep-runner (stale)')
  })
})

describe('BranchGraph', () => {
  const mountIt = () =>
    mount(BranchGraph, {
      props: { trunk: 'main', branches },
      global: { stubs: { RouterLink: RouterLinkStub } },
    })
  it('makes marks with `to` links and the rest focusable, each named', () => {
    const w = mountIt()
    const wide = w.find('.iu-branch-graph__wide')
    const links = wide.findAllComponents(RouterLinkStub)
    expect(links).toHaveLength(1)
    expect(links[0]!.props('to')).toBe('/s/1')
    expect(links[0]!.attributes('aria-label')).toBe('item/26: Remove Pi')
    const plain = wide.find('span.iu-branch-graph__mark')
    expect(plain.attributes('tabindex')).toBe('0')
    expect(plain.attributes('aria-label')).toBe('keep-runner: Stale worktree')
  })
  it('renders the plain list for narrow screens and hides the drawing', () => {
    const w = mountIt()
    expect(w.find('svg').attributes('aria-hidden')).toBe('true')
    const items = w.findAll('.iu-branch-graph__list-name').map(x => x.text())
    expect(items).toEqual(['item/26 (merged)', 'keep-runner (stale)'])
  })
})
